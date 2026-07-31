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

  it("disables multiple agent selection while in direct mode", async () => {
    renderDialog();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));

    // A direct session can only ever have one agent (there's only one
    // checkout to run it in) — the toggle must be unusable, not just
    // reactively undone after the fact, so users don't land in a state
    // where their branch/mode choice silently reverted.
    expect(screen.getByLabelText("Enable multiple agent selection")).toBeDisabled();
  });

  it("disables multiple agent selection while in existing-branch mode", async () => {
    renderDialog();

    await fireEvent.click(screen.getByText("Use existing branch"));

    expect(screen.getByLabelText("Enable multiple agent selection")).toBeDisabled();
  });

  it("turns off multiple agent selection when switching to direct mode", async () => {
    renderDialog();

    // Multi-select on with only one agent actually checked: the "run
    // directly"/"use existing" links are still offered at this point (they
    // only hide once a *second* agent is picked), which is exactly the path
    // that used to silently bounce the whole dialog back to "new" mode.
    await fireEvent.click(screen.getByLabelText("Enable multiple agent selection"));
    expect(screen.getByText("Agents (1 selected)")).toBeInTheDocument();

    await fireEvent.click(screen.getByText("Run directly on branch (no worktree)"));

    // Switching to direct mode turns multi-select back off instead of
    // bouncing the whole dialog back to "new" behind the user's back — the
    // branch/mode they chose sticks, and the toggle is now disabled too.
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Branch to run directly on")).toBeInTheDocument();
    expect(screen.getByLabelText("Enable multiple agent selection")).toBeDisabled();
  });
});
