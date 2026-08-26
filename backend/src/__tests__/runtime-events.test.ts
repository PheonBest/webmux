import { describe, expect, it } from "bun:test";
import { parseRuntimeEvent } from "../domain/events";

describe("parseRuntimeEvent", () => {
  it("parses valid runtime events", () => {
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
    })).toEqual({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
    });
  });

  it("parses an agent_last_tool event", () => {
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_last_tool",
      toolName: "Monitor",
    })).toEqual({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_last_tool",
      toolName: "Monitor",
    });
  });

  it("rejects an agent_last_tool event with no toolName", () => {
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_last_tool",
    })).toBeNull();
  });

  it("rejects malformed runtime events", () => {
    expect(parseRuntimeEvent(null)).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_started",
    })).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "title_changed",
      title: "ignored",
    })).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "closed",
    })).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "runtime_error",
    })).toBeNull();
  });
});
