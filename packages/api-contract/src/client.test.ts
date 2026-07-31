import { describe, expect, it } from "bun:test";
import { ApiError, createApi } from "./client";

function success(body: unknown): { status: number; body: unknown; headers: Headers } {
  return {
    status: 200,
    body,
    headers: new Headers(),
  };
}

describe("createApi", () => {
  it("encodes slash-containing path params before ts-rest interpolates them", async () => {
    const paths: string[] = [];
    const api = createApi("https://example.com", {
      api: async ({ path }) => {
        paths.push(path);
        return success({ ok: true });
      },
    });

    await api.sendWorktreePrompt({
      params: { name: "feature/search" },
      body: { text: "Fix the failing tests" },
    });

    expect(paths).toEqual(["https://example.com/api/worktrees/feature%2Fsearch/send"]);
  });

  it("preserves numeric path params for notification and CI routes", async () => {
    const paths: string[] = [];
    const api = createApi("https://example.com", {
      api: async ({ path }) => {
        paths.push(path);
        if (path.endsWith("/dismiss")) {
          return success({ ok: true });
        }
        return success({ logs: "" });
      },
    });

    await api.dismissNotification({ params: { id: 42 } });
    await api.fetchCiLogs({ params: { runId: 317 } });

    expect(paths).toEqual([
      "https://example.com/api/notifications/42/dismiss",
      "https://example.com/api/ci-logs/317",
    ]);
  });

  it("throws API error messages from json error bodies", async () => {
    const api = createApi("https://example.com", {
      api: async () => ({
        status: 404,
        body: { error: "Not found" },
        headers: new Headers(),
      }),
    });

    await expect(api.dismissNotification({ params: { id: 7 } })).rejects.toThrow("Not found");
  });

  it("throws API error messages from stringified json error bodies", async () => {
    const api = createApi("https://example.com", {
      api: async () => ({
        status: 502,
        body: JSON.stringify({ error: "Gateway unavailable" }),
        headers: new Headers(),
      }),
    });

    await expect(api.fetchCiLogs({ params: { runId: 99 } })).rejects.toThrow("Gateway unavailable");
  });

  it("throws an ApiError carrying the server's machine-readable error code", async () => {
    const api = createApi("https://example.com", {
      api: async () => ({
        status: 409,
        body: { error: "dirty", code: "direct_switch_dirty" },
        headers: new Headers(),
      }),
    });

    try {
      await api.mergeWorktree({ params: { name: "feature" } });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("direct_switch_dirty");
      expect((error as ApiError).status).toBe(409);
    }
  });

  it("leaves code undefined when the server doesn't provide one", async () => {
    const api = createApi("https://example.com", {
      api: async () => ({
        status: 404,
        body: { error: "Not found" },
        headers: new Headers(),
      }),
    });

    try {
      await api.mergeWorktree({ params: { name: "feature" } });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBeUndefined();
    }
  });
});
