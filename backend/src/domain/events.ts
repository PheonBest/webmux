export type RuntimeEventType =
  | "agent_stopped"
  | "agent_status_changed"
  | "pr_opened"
  | "runtime_error"
  | "agent_last_tool";

interface RuntimeEventBase {
  worktreeId: string;
  branch: string;
  type: RuntimeEventType;
}

export interface AgentStoppedEvent extends RuntimeEventBase {
  type: "agent_stopped";
}

export interface AgentStatusChangedEvent extends RuntimeEventBase {
  type: "agent_status_changed";
  lifecycle: "starting" | "running" | "idle" | "stopped";
}

export interface PrOpenedEvent extends RuntimeEventBase {
  type: "pr_opened";
  url?: string;
}

export interface RuntimeErrorEvent extends RuntimeEventBase {
  type: "runtime_error";
  message: string;
}

/** Reports the name of the tool the agent just called — used only to decide
 *  whether a following `agent_stopped` is a real stop or a soft pause the
 *  agent will resume on its own (see `WAIT_TOOL_NAMES` in server.ts). Never
 *  applied to runtime state or surfaced as a notification. */
export interface AgentLastToolEvent extends RuntimeEventBase {
  type: "agent_last_tool";
  toolName: string;
}

export type RuntimeEvent =
  | AgentStoppedEvent
  | AgentStatusChangedEvent
  | PrOpenedEvent
  | RuntimeErrorEvent
  | AgentLastToolEvent;

function hasBaseFields(raw: Record<string, unknown>): raw is Record<string, string> & { type: RuntimeEventType } {
  return typeof raw.worktreeId === "string"
    && raw.worktreeId.length > 0
    && typeof raw.branch === "string"
    && raw.branch.length > 0
    && typeof raw.type === "string"
    && ["agent_stopped", "agent_status_changed", "pr_opened", "runtime_error", "agent_last_tool"].includes(raw.type);
}

export function parseRuntimeEvent(raw: unknown): RuntimeEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!hasBaseFields(raw as Record<string, unknown>)) return null;

  const event = raw as Record<string, unknown> & {
    worktreeId: string;
    branch: string;
    type: RuntimeEventType;
  };

  switch (event.type) {
    case "agent_stopped":
      return {
        worktreeId: event.worktreeId,
        branch: event.branch,
        type: event.type,
      };
    case "agent_status_changed":
      return event.lifecycle === "starting"
          || event.lifecycle === "running"
          || event.lifecycle === "idle"
          || event.lifecycle === "stopped"
        ? {
            worktreeId: event.worktreeId,
            branch: event.branch,
            type: event.type,
            lifecycle: event.lifecycle,
          }
        : null;
    case "pr_opened":
      return typeof event.url === "string" || event.url === undefined
        ? {
            worktreeId: event.worktreeId,
            branch: event.branch,
            type: event.type,
            ...(typeof event.url === "string" ? { url: event.url } : {}),
          }
        : null;
    case "runtime_error":
      return typeof event.message === "string" && event.message.length > 0
        ? {
            worktreeId: event.worktreeId,
            branch: event.branch,
            type: event.type,
            message: event.message,
          }
        : null;
    case "agent_last_tool":
      return typeof event.toolName === "string" && event.toolName.length > 0
        ? {
            worktreeId: event.worktreeId,
            branch: event.branch,
            type: event.type,
            toolName: event.toolName,
          }
        : null;
  }
}
