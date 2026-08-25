import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../adapters/config";

function run(args: string[], cwd: string): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${args.join(" ")} failed: ${stderr || `exit ${result.exitCode}`}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function initRepo(prefix: string): Promise<string> {
  const repoRoot = await mktemp(prefix);
  run(["git", "init", "-b", "main"], repoRoot);
  run(["git", "config", "user.name", "Test User"], repoRoot);
  run(["git", "config", "user.email", "test@example.com"], repoRoot);
  await Bun.write(join(repoRoot, "README.md"), "# repo\n");
  run(["git", "add", "README.md"], repoRoot);
  run(["git", "commit", "-m", "init"], repoRoot);
  return repoRoot;
}

async function mktemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("projectRoot", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a submodule's own root instead of the superproject's", async () => {
    const subRepo = await initRepo("webmux-config-sub-");
    tempDirs.push(subRepo);
    const superRepo = await initRepo("webmux-config-super-");
    tempDirs.push(superRepo);

    run(["git", "-c", "protocol.file.allow=always", "submodule", "add", subRepo, "sub"], superRepo);

    const submoduleDir = join(superRepo, "sub");

    expect(projectRoot(submoduleDir)).toBe(run(["git", "rev-parse", "--show-toplevel"], submoduleDir));
  });

  it("resolves the main repo root from a linked worktree", async () => {
    const repoRoot = await initRepo("webmux-config-main-");
    tempDirs.push(repoRoot);
    const worktreeDir = join(repoRoot, "wt");
    run(["git", "worktree", "add", "-b", "feature", worktreeDir], repoRoot);

    expect(projectRoot(worktreeDir)).toBe(run(["git", "rev-parse", "--show-toplevel"], repoRoot));
  });
});
