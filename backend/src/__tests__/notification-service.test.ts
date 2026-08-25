import { describe, expect, it } from "bun:test";
import { NotificationService } from "../services/notification-service";

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return new TextDecoder().decode(chunk.value);
}

describe("NotificationService", () => {
  it("creates notifications only for user-visible runtime events", () => {
    const notifications = new NotificationService();

    const started = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_status_changed", lifecycle: "running" },
    );
    const stopped = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
    );

    expect(started).toBeNull();
    expect(stopped?.type).toBe("agent_stopped");
    expect(notifications.list()).toHaveLength(1);
  });

  it("stores pr_opened and runtime_error notifications with details", () => {
    const notifications = new NotificationService();

    const pr = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "pr_opened", url: "https://github.com/org/repo/pull/123" },
    );
    const error = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "runtime_error", message: "agent crashed" },
    );

    expect(pr?.url).toBe("https://github.com/org/repo/pull/123");
    expect(error?.message).toContain("agent crashed");
    expect(notifications.list()).toHaveLength(2);
  });

  it("dismisses notifications by id", () => {
    const notifications = new NotificationService();
    const item = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
    );

    expect(item).not.toBeNull();
    expect(notifications.dismiss(item!.id)).toBe(true);
    expect(notifications.list()).toHaveLength(0);
  });

  it("streams initial notifications and broadcasts live updates", async () => {
    const notifications = new NotificationService();
    const initial = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
    );

    const response = notifications.stream();
    const reader = response.body!.getReader();

    const initialChunk = await readChunk(reader);
    expect(initialChunk).toContain("event: initial");
    expect(initialChunk).toContain(`\"id\":${initial!.id}`);

    const liveChunkPromise = readChunk(reader);
    const live = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "pr_opened", url: "https://github.com/org/repo/pull/123" },
    );
    const liveChunk = await liveChunkPromise;
    expect(liveChunk).toContain("event: notification");
    expect(liveChunk).toContain(`\"id\":${live!.id}`);

    const dismissChunkPromise = readChunk(reader);
    expect(notifications.dismiss(live!.id)).toBe(true);
    const dismissChunk = await dismissChunkPromise;
    expect(dismissChunk).toContain("event: dismiss");
    expect(dismissChunk).toContain(`\"id\":${live!.id}`);

    await reader.cancel();
  });

  it("invokes onNotify listeners for every notify(), and stops after unsubscribe", () => {
    const notifications = new NotificationService();
    const received: string[] = [];
    const unsubscribe = notifications.onNotify((n) => received.push(n.message));

    notifications.recordEvent({ worktreeId: "wt_a", branch: "feature/a", type: "agent_stopped" });
    unsubscribe();
    notifications.recordEvent({ worktreeId: "wt_b", branch: "feature/b", type: "agent_stopped" });

    expect(received).toEqual(["Agent stopped on feature/a"]);
  });

  it("does not let a throwing listener break notify() or other listeners", () => {
    const notifications = new NotificationService();
    const received: string[] = [];
    notifications.onNotify(() => {
      throw new Error("boom");
    });
    notifications.onNotify((n) => received.push(n.message));

    const result = notifications.recordEvent({ worktreeId: "wt_a", branch: "feature/a", type: "agent_stopped" });

    expect(result?.type).toBe("agent_stopped");
    expect(received).toEqual(["Agent stopped on feature/a"]);
  });
});
