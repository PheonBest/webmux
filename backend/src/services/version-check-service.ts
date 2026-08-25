import { log } from "../lib/log";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

export const bunGitCommandRunner: GitCommandRunner = async (args, cwd) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { ok: exitCode === 0, stdout: stdout.trim() };
};

export interface VersionCheckResult {
  /** Short commit SHA the running server was built from, or null when the
   *  webmux repo root couldn't be resolved (e.g. a real npm/registry install
   *  rather than a git-linked dev checkout — see resolveWebmuxGitRepoRoot). */
  currentCommit: string | null;
  latestCommit: string | null;
  commitsBehind: number;
  updateAvailable: boolean;
}

const NO_UPDATE_RESULT: VersionCheckResult = {
  currentCommit: null,
  latestCommit: null,
  commitsBehind: 0,
  updateAvailable: false,
};

export interface VersionCheckDependencies {
  /** webmux's own git repo root (see resolveWebmuxGitRepoRoot), or null when
   *  this isn't a git-linked install — the check then always reports no
   *  update available, since there's no origin/main to compare against. */
  repoRoot: string | null;
  runGit?: GitCommandRunner;
  remote?: string;
  mainBranch?: string;
  now?: () => number;
  ttlMs?: number;
}

/** Compares the running build's commit against `origin/<mainBranch>` —
 *  caches the result so the frontend can poll freely without a `git fetch`
 *  (network round-trip) on every request. */
export class VersionCheckService {
  private cached: { result: VersionCheckResult; fetchedAt: number } | null = null;
  private readonly runGit: GitCommandRunner;
  private readonly remote: string;
  private readonly mainBranch: string;

  constructor(private readonly deps: VersionCheckDependencies) {
    this.runGit = deps.runGit ?? bunGitCommandRunner;
    this.remote = deps.remote ?? "origin";
    this.mainBranch = deps.mainBranch ?? "main";
  }

  /** Force a fresh check on the next `check()` call, bypassing the TTL cache
   *  — used by the Settings "Check for updates" button. */
  invalidate(): void {
    this.cached = null;
  }

  async check(): Promise<VersionCheckResult> {
    const now = (this.deps.now ?? Date.now)();
    const ttlMs = this.deps.ttlMs ?? 60 * 60 * 1000;
    if (this.cached && now - this.cached.fetchedAt <= ttlMs) {
      return this.cached.result;
    }

    const result = await this.runCheck();
    this.cached = { result, fetchedAt: now };
    return result;
  }

  private async runCheck(): Promise<VersionCheckResult> {
    if (!this.deps.repoRoot) return NO_UPDATE_RESULT;
    const repoRoot = this.deps.repoRoot;

    const fetchResult = await this.runGit(["fetch", this.remote, this.mainBranch, "--quiet"], repoRoot);
    if (!fetchResult.ok) {
      log.debug("[version-check] git fetch failed — treating as offline, no update surfaced");
      return NO_UPDATE_RESULT;
    }

    const remoteRef = `${this.remote}/${this.mainBranch}`;
    const [current, latest, count] = await Promise.all([
      this.runGit(["rev-parse", "--short", "HEAD"], repoRoot),
      this.runGit(["rev-parse", "--short", remoteRef], repoRoot),
      this.runGit(["rev-list", "--count", `HEAD..${remoteRef}`], repoRoot),
    ]);

    const commitsBehind = count.ok ? Number.parseInt(count.stdout, 10) || 0 : 0;
    return {
      currentCommit: current.ok ? current.stdout : null,
      latestCommit: latest.ok ? latest.stdout : null,
      commitsBehind,
      updateAvailable: commitsBehind > 0,
    };
  }
}
