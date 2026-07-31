import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateWorktreeDialog from "./CreateWorktreeDialog.svelte";
import type { AgentSummary, CreateWorktreeRequest, ProfileConfig } from "./types";

const PROFILES: ProfileConfig[] = [{ name: "default" }];

const AGENTS: AgentSummary[] = [
  {
    id: "claude",
    label: "Claude",
    kind: "builtin",
    capabilities: { terminal: true, inAppChat: true, conversationHistory: true, interrupt: true, resume: true },
  },
  {
    id: "codex",
    label: "Codex",
    kind: "builtin",
    capabilities: { terminal: true, inAppChat: true, conversationHistory: true, interrupt: true, resume: true },
  },
];

function renderDialog(overrides: {
  oncreate?: (request: CreateWorktreeRequest) => void;
  oncancel?: () => void;
} = {}): { oncreate: ReturnType<typeof vi.fn> } {
  const oncreate = overrides.oncreate ?? vi.fn();
  render(CreateWorktreeDialog, {
    props: {
      profiles: PROFILES,
      agents: AGENTS,
      defaultProfileName: "default",
      defaultAgentId: "claude",
      availableBranches: [{ name: "main" }, { name: "release/1.0" }],
      includeRemoteBranches: false,
      oncreate,
      oncancel: overrides.oncancel ?? vi.fn(),
    },
  });
  return { oncreate: oncreate as ReturnType<typeof vi.fn> };
}

describe("CreateWorktreeDialog — direct mode", () => {
  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it("offers a 'run directly on branch' option alongside 'use existing branch'", () => {
    renderDialog();

    expect(screen.getByText("Use existing branch")).toBeInTheDocument();
    expect(screen.getByText("Run directly on branch (no worktree)")).toBeInTheDocument();
  });

  it("switches to direct mode, selects a branch, and submits mode: direct", async () => {
    const { oncreate } = renderDialog();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));
    await fireEvent.click(screen.getByText("main"));
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(oncreate).toHaveBeenCalledTimes(1);
    const request = oncreate.mock.calls[0][0] as CreateWorktreeRequest;
    expect(request.mode).toBe("direct");
    expect(request.branch).toBe("main");
    // Base branch never applies to a direct session.
    expect(request.baseBranch).toBeUndefined();
  });

  it("explains the single-session and no-branch-deletion semantics for direct mode", async () => {
    renderDialog();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));

    expect(screen.getByText(/no separate worktree/i)).toBeInTheDocument();
    expect(screen.getByText(/Only one such session can run at a time/i)).toBeInTheDocument();
    expect(screen.getByText(/never deletes the branch/i)).toBeInTheDocument();
  });

  it("does not offer base branch or Linear ticket creation in direct mode", async () => {
    renderDialog();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));

    expect(screen.queryByText("Base branch")).not.toBeInTheDocument();
    expect(screen.queryByText("Create Linear ticket")).not.toBeInTheDocument();
  });

  it("disables submit until a branch is selected in direct mode", async () => {
    renderDialog();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    await fireEvent.click(screen.getByText("main"));
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
  });

  it("falls back to new-branch mode if multiple agents get selected while in direct mode", async () => {
    renderDialog();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));
    await fireEvent.click(screen.getByText("main"));

    await fireEvent.click(screen.getByLabelText("Enable multiple agent selection"));
    await fireEvent.click(screen.getByText("Codex").closest("label")!.querySelector("input")!);

    // Selecting a second agent while in direct mode should bounce back to
    // "new" mode — a direct session can only ever have one agent. The direct
    // branch selector is gone, replaced by the new-branch/multi-agent UI.
    expect(screen.queryByText("Branch to run directly on")).not.toBeInTheDocument();
    expect(screen.getByText("A separate prefixed branch will be created for each selected agent.")).toBeInTheDocument();
  });
});
