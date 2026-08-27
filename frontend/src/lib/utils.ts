import type { PrEntry, ProjectInitPhase, WorktreeCreationPhase, WorktreeInfo } from "./types";
import { THEME_KEYS, getTheme } from "./themes";
import type { ThemeKey } from "./themes";

export const SSH_STORAGE_KEY = "wt-ssh-host";
export const THEME_STORAGE_KEY = "wt-theme";
export const LAST_SELECTED_WORKTREE_STORAGE_KEY = "wt-last-selected-worktree";
export const SIDEBAR_WIDTH_STORAGE_KEY = "wt-sidebar-width";
export const WEB_CHAT_UI_STORAGE_KEY = "wt-use-web-chat-ui";
const DEFAULT_SIDEBAR_WIDTH = 220;

export function prLabel(pr: Pick<PrEntry, "repo" | "number">): string {
  return pr.repo ? `${pr.repo} #${pr.number}` : `PR #${pr.number}`;
}

export function isDraftPr(pr: Pick<PrEntry, "state" | "isDraft">): boolean {
  return pr.state === "open" && pr.isDraft;
}

export function prStateTextClass(pr: Pick<PrEntry, "state" | "isDraft">): string {
  if (pr.state === "merged") return "text-merged";
  if (pr.state === "closed") return "text-danger";
  if (isDraftPr(pr)) return "text-muted";
  return "text-primary";
}

export function prBadgeClass(pr: Pick<PrEntry, "state" | "isDraft">): string {
  if (pr.state === "merged") return "bg-merged/20 text-merged";
  if (pr.state === "closed") return "bg-danger/20 text-danger";
  if (isDraftPr(pr)) return "bg-muted/20 text-muted";
  if (pr.state === "open") return "bg-success/20 text-success";
  return "bg-muted/20 text-muted";
}

export function ciStatusTextClass(ciStatus: PrEntry["ciStatus"]): string {
  if (ciStatus === "failed") return "text-danger";
  if (ciStatus === "success") return "text-success";
  if (ciStatus === "pending") return "text-warning";
  return "text-muted";
}

export function ciStatusDotClass(ciStatus: PrEntry["ciStatus"]): string {
  if (ciStatus === "failed") return "bg-danger";
  if (ciStatus === "success") return "bg-success";
  if (ciStatus === "pending") return "bg-warning animate-pulse";
  return "bg-muted";
}

export function prStatusShellClass(pr: Pick<PrEntry, "ciChecks" | "ciStatus" | "state">): string {
  if (pr.ciChecks.length > 0) {
    if (pr.ciStatus === "failed") return "border-danger/40 bg-danger/5";
    if (pr.ciStatus === "pending") return "border-warning/40 bg-warning/5";
    if (pr.ciStatus === "success") return "border-success/30 bg-success/5";
  }
  if (pr.state === "merged") return "border-merged/35 bg-merged/8";
  if (pr.state === "closed") return "border-danger/35 bg-danger/5";
  return "border-edge bg-surface";
}

/** Resolves the SSH host to use for "Open in VS Code / Cursor" links.
 *  An explicit setting always wins; otherwise fall back to the address the
 *  browser is currently on, so remote access works without configuration.
 *  Returns "" (local mode) only for loopback / missing hostnames. */
export function deriveSshHost(manual: string | null | undefined, hostname: string): string {
  const trimmed = manual?.trim();
  if (trimmed) return trimmed;
  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return "";
  }
  return hostname;
}

export function makeCursorUrl(dir: string | null | undefined, sshHost: string | null): string | null {
  if (!dir) return null;
  if (sshHost) return `cursor://vscode-remote/ssh-remote+${sshHost}${dir}`;
  return `cursor://file${dir}`;
}

export function makeVscodeUrl(dir: string | null | undefined, sshHost: string | null): string | null {
  if (!dir) return null;
  if (sshHost) return `vscode://vscode-remote/ssh-remote+${sshHost}${dir}`;
  return `vscode://file${dir}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function searchMatch(needle: string, haystack: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function loadSavedTheme(): ThemeKey {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored && (THEME_KEYS as readonly string[]).includes(stored)) return stored as ThemeKey;
  return "github-dark";
}

export function loadSavedSelectedWorktree(): string | null {
  const stored = localStorage.getItem(LAST_SELECTED_WORKTREE_STORAGE_KEY)?.trim();
  return stored ? stored : null;
}

/** Reads `?workspace=<branch>` from the current URL — the deep-link param a
 *  push notification or Discord alert points to (see buildWorkspaceDeepLink
 *  on the backend). Takes priority over the locally saved selection so a
 *  notification link always lands on the workspace it names. */
export function readWorkspaceQueryParam(): string | null {
  const value = new URLSearchParams(window.location.search).get("workspace")?.trim();
  return value ? value : null;
}

/** Strips `?workspace=...` from the URL after it's been applied, so a reload
 *  or later navigation doesn't keep forcing the same selection. */
export function clearWorkspaceQueryParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("workspace")) return;
  url.searchParams.delete("workspace");
  window.history.replaceState(null, "", url.toString());
}

export function saveSelectedWorktree(branch: string | null): void {
  if (branch) {
    localStorage.setItem(LAST_SELECTED_WORKTREE_STORAGE_KEY, branch);
    return;
  }
  localStorage.removeItem(LAST_SELECTED_WORKTREE_STORAGE_KEY);
}

export function applyTheme(key: ThemeKey): void {
  const theme = getTheme(key);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--color-${name}`, value);
  }
  localStorage.setItem(THEME_STORAGE_KEY, key);
}

export function loadSavedSidebarWidth(): number {
  const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function saveSidebarWidth(width: number): void {
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
}

export function loadUseWebChatUi(): boolean {
  return localStorage.getItem(WEB_CHAT_UI_STORAGE_KEY) === "true";
}

export function saveUseWebChatUi(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(WEB_CHAT_UI_STORAGE_KEY, "true");
    return;
  }

  localStorage.removeItem(WEB_CHAT_UI_STORAGE_KEY);
}

export function worktreeCreationPhaseLabel(phase: WorktreeCreationPhase | null): string {
  switch (phase) {
    case "creating_worktree":
      return "Creating worktree";
    case "preparing_runtime":
      return "Preparing runtime";
    case "running_post_create_hook":
      return "Running post-create hook";
    case "starting_session":
      return "Starting session";
    case "reconciling":
      return "Reconciling";
    default:
      return "Creating";
  }
}

export function projectInitPhaseLabel(phase: ProjectInitPhase | null): string {
  switch (phase) {
    case "creating_config":
      return "Creating .webmux.yaml";
    case "analyzing":
      return "Analyzing project structure";
    case "ready":
      return "Project ready";
    case "failed":
      return "Setup failed";
    default:
      return "Setting up";
  }
}

export function resolveSelectedBranch(
  selectedBranch: string | null,
  selectedWorktree: Pick<WorktreeInfo, "branch"> | undefined,
  selectableWorktrees: Array<Pick<WorktreeInfo, "branch" | "mux">>,
  hasLoadedWorktrees: boolean,
): string | null {
  if (selectedBranch && selectedWorktree) return selectedBranch;
  if (!hasLoadedWorktrees) return selectedBranch;
  if (selectableWorktrees.length === 0) return null;

  const open = selectableWorktrees.find((worktree) => worktree.mux === "✓");
  return (open ?? selectableWorktrees[0]).branch;
}
