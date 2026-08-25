import { describe, expect, it } from "bun:test";
import { VersionCheckService, type GitCommandRunner, type GitCommandResult } from "../services/version-check-service";

function fakeGit(responses: Record<string, GitCommandResult>): GitCommandRunner {
  return async (args) => {
    const key = args.join(" ");
    return responses[key] ?? { ok: false, stdout: "" };
  };
}

describe("VersionCheckService", () => {
  it("reports no update when repoRoot is null (not a git-linked install)", async () => {
    const service = new VersionCheckService({ repoRoot: null, runGit: fakeGit({}) });
    expect(await service.check()).toEqual({
      currentCommit: null,
      latestCommit: null,
      commitsBehind: 0,
      updateAvailable: false,
    });
  });

  it("reports updateAvailable when origin/main is ahead of HEAD", async () => {
    const runGit = fakeGit({
      "fetch origin main --quiet": { ok: true, stdout: "" },
      "rev-parse --short HEAD": { ok: true, stdout: "abc1234" },
      "rev-parse --short origin/main": { ok: true, stdout: "def5678" },
      "rev-list --count HEAD..origin/main": { ok: true, stdout: "3" },
    });
    const service = new VersionCheckService({ repoRoot: "/repo", runGit });

    expect(await service.check()).toEqual({
      currentCommit: "abc1234",
      latestCommit: "def5678",
      commitsBehind: 3,
      updateAvailable: true,
    });
  });

  it("reports no update when HEAD already matches origin/main", async () => {
    const runGit = fakeGit({
      "fetch origin main --quiet": { ok: true, stdout: "" },
      "rev-parse --short HEAD": { ok: true, stdout: "abc1234" },
      "rev-parse --short origin/main": { ok: true, stdout: "abc1234" },
      "rev-list --count HEAD..origin/main": { ok: true, stdout: "0" },
    });
    const service = new VersionCheckService({ repoRoot: "/repo", runGit });

    expect((await service.check()).updateAvailable).toBe(false);
  });

  it("treats a failed fetch (offline) as no update available, not an error", async () => {
    const runGit = fakeGit({ "fetch origin main --quiet": { ok: false, stdout: "" } });
    const service = new VersionCheckService({ repoRoot: "/repo", runGit });

    expect(await service.check()).toEqual({
      currentCommit: null,
      latestCommit: null,
      commitsBehind: 0,
      updateAvailable: false,
    });
  });

  it("caches the result within the TTL", async () => {
    let calls = 0;
    let now = 0;
    const runGit: GitCommandRunner = async (args) => {
      calls += 1;
      if (args[0] === "fetch") return { ok: true, stdout: "" };
      if (args.includes("HEAD") && args[1] === "--short") return { ok: true, stdout: "abc1234" };
      if (args.includes("origin/main") && args[1] === "--short") return { ok: true, stdout: "abc1234" };
      return { ok: true, stdout: "0" };
    };
    const service = new VersionCheckService({ repoRoot: "/repo", runGit, now: () => now, ttlMs: 1000 });

    await service.check();
    const firstCallCount = calls;
    now = 500;
    await service.check();
    expect(calls).toBe(firstCallCount);

    now = 1500;
    await service.check();
    expect(calls).toBeGreaterThan(firstCallCount);
  });

  it("invalidate() forces a fresh check on the next call", async () => {
    let calls = 0;
    const runGit: GitCommandRunner = async (args) => {
      if (args[0] === "fetch") {
        calls += 1;
        return { ok: true, stdout: "" };
      }
      return { ok: true, stdout: "abc1234" };
    };
    const service = new VersionCheckService({ repoRoot: "/repo", runGit, ttlMs: 1_000_000 });

    await service.check();
    await service.check();
    expect(calls).toBe(1);

    service.invalidate();
    await service.check();
    expect(calls).toBe(2);
  });
});
