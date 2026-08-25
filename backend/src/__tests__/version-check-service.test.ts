import { describe, expect, it } from "bun:test";
import { compareVersions, isNewerVersion, VersionCheckService } from "../services/version-check-service";

describe("compareVersions", () => {
  it("compares dotted version strings numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats missing segments as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });
});

describe("isNewerVersion", () => {
  it("is true when latest is greater than current", () => {
    expect(isNewerVersion("0.43.1", "0.44.0")).toBe(true);
  });

  it("is false when latest is equal or older", () => {
    expect(isNewerVersion("0.43.1", "0.43.1")).toBe(false);
    expect(isNewerVersion("0.43.1", "0.43.0")).toBe(false);
  });
});

describe("VersionCheckService", () => {
  it("reports updateAvailable when the registry has a newer version", async () => {
    const service = new VersionCheckService({
      currentVersion: "0.43.1",
      fetchLatest: async () => "0.44.0",
    });

    expect(await service.check()).toEqual({
      current: "0.43.1",
      latest: "0.44.0",
      updateAvailable: true,
    });
  });

  it("caches the registry lookup within the TTL", async () => {
    let calls = 0;
    let now = 0;
    const service = new VersionCheckService({
      currentVersion: "0.43.1",
      fetchLatest: async () => {
        calls += 1;
        return "0.44.0";
      },
      now: () => now,
      ttlMs: 1000,
    });

    await service.check();
    now = 500;
    await service.check();
    expect(calls).toBe(1);

    now = 1500;
    await service.check();
    expect(calls).toBe(2);
  });

  it("reports no update available when the registry lookup fails", async () => {
    const service = new VersionCheckService({
      currentVersion: "0.43.1",
      fetchLatest: async () => null,
    });

    expect(await service.check()).toEqual({
      current: "0.43.1",
      latest: null,
      updateAvailable: false,
    });
  });
});
