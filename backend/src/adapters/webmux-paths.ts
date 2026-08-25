import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** webmux's XDG-style config directory (`~/.config/webmux`). Home to the
 *  control token and the optional global env file. Distinct from the
 *  `~/.webmux` runtime-state dir (projects registry, live-instance registry),
 *  which holds transient state rather than user config. */
export function webmuxConfigDir(): string {
  return join(Bun.env.HOME ?? "/root", ".config", "webmux");
}

/** Optional global env file webmux reads at server startup for machine-wide
 *  secrets (e.g. `LINEAR_API_KEY`). Loaded after the launch project's `.env`
 *  so a project can still override a machine-wide default. */
export function webmuxConfigEnvPath(): string {
  return join(webmuxConfigDir(), ".env");
}

/** Resolves the source checkout backing the running `webmux` binary, when
 *  it's a git-linked dev install (`bun link`/`bun install --global` from a
 *  local path — the global `webmux` symlink resolves through `bin/webmux.js`
 *  straight into the repo). Returns null for a real npm/registry install
 *  (resolves into `node_modules/webmux`, no `.git` two levels up) or when
 *  `webmux` isn't found on PATH at all. Used to decide whether "check for
 *  updates" means "compare against origin/main" or "check the npm registry". */
export function resolveWebmuxGitRepoRoot(): string | null {
  const which = Bun.spawnSync(["which", "webmux"], { stdout: "pipe", stderr: "pipe" });
  if (!which.success) return null;
  const binPath = which.stdout.toString().trim();
  if (!binPath) return null;

  let resolved: string;
  try {
    resolved = realpathSync(binPath);
  } catch {
    return null;
  }

  // `resolved` is `<repoRoot>/bin/webmux.js` for a git-linked install.
  const repoRoot = dirname(dirname(resolved));
  return existsSync(join(repoRoot, ".git")) ? repoRoot : null;
}
