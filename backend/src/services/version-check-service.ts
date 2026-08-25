import { log } from "../lib/log";

/** Compares two dotted version strings (e.g. "0.43.1"). Returns -1 if `a` <
 *  `b`, 1 if `a` > `b`, 0 if equal. Missing/non-numeric segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

export async function fetchLatestNpmVersion(packageName: string, timeoutMs = 5000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch (error) {
    log.debug(`[version-check] failed to fetch latest ${packageName} version: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export interface VersionCheckDependencies {
  currentVersion: string;
  fetchLatest: () => Promise<string | null>;
  now?: () => number;
  ttlMs?: number;
}

/** Caches the npm registry lookup so the frontend can poll /api/version-check
 *  freely without hammering the registry — refreshed at most once per TTL. */
export class VersionCheckService {
  private cached: { latest: string | null; fetchedAt: number } | null = null;

  constructor(private readonly deps: VersionCheckDependencies) {}

  async check(): Promise<VersionCheckResult> {
    const now = (this.deps.now ?? Date.now)();
    const ttlMs = this.deps.ttlMs ?? 60 * 60 * 1000;
    if (!this.cached || now - this.cached.fetchedAt > ttlMs) {
      const latest = await this.deps.fetchLatest();
      this.cached = { latest, fetchedAt: now };
    }

    const { latest } = this.cached;
    return {
      current: this.deps.currentVersion,
      latest,
      updateAvailable: latest !== null && isNewerVersion(this.deps.currentVersion, latest),
    };
  }
}
