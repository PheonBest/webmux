import type { AgentId } from "../domain/config";
import { ROOT_TAB_ID, type WorktreeMeta, type WorktreeTab } from "../domain/model";

/** Pure helpers for reading and transforming a worktree's tab list. All return
 *  new objects — no mutation — so they are trivially unit-testable. */

export function listTabs(meta: WorktreeMeta): WorktreeTab[] {
  return meta.tabs ?? [];
}

export function findTab(meta: WorktreeMeta, tabId: string): WorktreeTab | undefined {
  return listTabs(meta).find((tab) => tab.tabId === tabId);
}

export function rootTab(meta: WorktreeMeta): WorktreeTab | undefined {
  const tabs = listTabs(meta);
  return tabs.find((tab) => tab.kind === "root") ?? tabs[0];
}

export function activeTabId(meta: WorktreeMeta): string {
  return meta.activeTabId ?? ROOT_TAB_ID;
}

/** Next fork number. Monotonic via `forkCounter` so deleting Fork 2 still yields Fork 4. */
export function nextForkSeq(meta: WorktreeMeta): number {
  return (meta.forkCounter ?? 0) + 1;
}

export function buildForkTab(input: {
  seq: number;
  sessionId: string | null;
  paneId?: string;
  createdAt: string;
}): WorktreeTab {
  return {
    tabId: `fork-${input.seq}`,
    kind: "fork",
    label: `Fork ${input.seq}`,
    seq: input.seq,
    sessionId: input.sessionId,
    ...(input.paneId ? { paneId: input.paneId } : {}),
    createdAt: input.createdAt,
  };
}

/** Append a fork tab, advance the monotonic counter, and make it active. */
export function appendTab(meta: WorktreeMeta, tab: WorktreeTab): WorktreeMeta {
  return {
    ...meta,
    tabs: [...listTabs(meta), tab],
    forkCounter: tab.seq ?? meta.forkCounter ?? 0,
    activeTabId: tab.tabId,
  };
}

/** Deterministic tab id for an agent's extra window — one per (worktree,
 *  agentId), so re-adding the same agent is idempotent/detectable. */
export function agentWindowTabId(agentId: AgentId): string {
  return `agent-window-${agentId}`;
}

export function findAgentWindowTab(meta: WorktreeMeta, agentId: AgentId): WorktreeTab | undefined {
  return listTabs(meta).find((tab) => tab.kind === "agent-window" && tab.agentId === agentId);
}

/** Build an `agent-window` tab: a *different* agent's own real tmux window
 *  within the same worktree (see WorktreeTabKind in domain/model.ts). Unlike
 *  `buildForkTab`, this doesn't consume the fork-numbering counter — forks and
 *  agent windows are independent tab families. */
export function buildAgentWindowTab(input: {
  agentId: AgentId;
  label: string;
  windowName: string;
  createdAt: string;
}): WorktreeTab {
  return {
    tabId: agentWindowTabId(input.agentId),
    kind: "agent-window",
    label: input.label,
    seq: null,
    sessionId: null,
    agentId: input.agentId,
    windowName: input.windowName,
    createdAt: input.createdAt,
  };
}

/** Append an agent-window tab without disturbing the current active tab
 *  (unlike `appendTab`/fork creation, adding an extra agent window shouldn't
 *  steal focus from whatever the user is looking at). */
export function appendAgentWindowTab(meta: WorktreeMeta, tab: WorktreeTab): WorktreeMeta {
  return {
    ...meta,
    tabs: [...listTabs(meta), tab],
  };
}

/** Remove a tab; if it was active, selection falls back to the root. */
export function removeTab(meta: WorktreeMeta, tabId: string): WorktreeMeta {
  return {
    ...meta,
    tabs: listTabs(meta).filter((tab) => tab.tabId !== tabId),
    activeTabId: activeTabId(meta) === tabId ? ROOT_TAB_ID : meta.activeTabId,
  };
}

export function updateTab(meta: WorktreeMeta, tabId: string, patch: Partial<WorktreeTab>): WorktreeMeta {
  return {
    ...meta,
    tabs: listTabs(meta).map((tab) => (tab.tabId === tabId ? { ...tab, ...patch } : tab)),
  };
}

export function setActiveTab(meta: WorktreeMeta, tabId: string): WorktreeMeta {
  return { ...meta, activeTabId: tabId };
}

/** Replace the full tab list (used by the reopen restore path). */
export function withTabs(meta: WorktreeMeta, tabs: WorktreeTab[]): WorktreeMeta {
  return { ...meta, tabs };
}
