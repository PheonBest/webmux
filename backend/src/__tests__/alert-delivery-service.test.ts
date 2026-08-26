import { describe, expect, it } from "bun:test";
import {
  buildDiscordMessage,
  buildWorkspaceDeepLink,
  resolveDiscordAgentIdentity,
  sendDiscordAlert,
  type DiscordSender,
  type DiscordWebhookPayload,
} from "../services/alert-delivery-service";

describe("buildWorkspaceDeepLink", () => {
  it("builds a deep link with the project prefix and workspace query param", () => {
    expect(
      buildWorkspaceDeepLink({ externalUrl: "http://100.81.194.124:5111", prefix: "sonicjs", branch: "advisor/008" }),
    ).toBe("http://100.81.194.124:5111/sonicjs?workspace=advisor%2F008");
  });

  it("omits the prefix segment when there is none", () => {
    expect(buildWorkspaceDeepLink({ externalUrl: "http://host:5111", branch: "main" })).toBe(
      "http://host:5111?workspace=main",
    );
  });

  it("strips a trailing slash from EXTERNAL_URL", () => {
    expect(buildWorkspaceDeepLink({ externalUrl: "http://host:5111/", branch: "main" })).toBe(
      "http://host:5111?workspace=main",
    );
  });

  it("returns null when EXTERNAL_URL is not configured", () => {
    expect(buildWorkspaceDeepLink({ branch: "main" })).toBeNull();
    expect(buildWorkspaceDeepLink({ externalUrl: "  ", branch: "main" })).toBeNull();
  });
});

describe("buildDiscordMessage", () => {
  it("includes the project name, message and link", () => {
    const message = buildDiscordMessage({
      projectName: "webmux",
      message: "Agent stopped on feature/x",
      url: "http://host/webmux?workspace=feature/x",
    });
    expect(message).toBe("**webmux** — Agent stopped on feature/x\nhttp://host/webmux?workspace=feature/x");
  });

  it("omits the link line when there's no URL", () => {
    const message = buildDiscordMessage({ projectName: "webmux", message: "Agent stopped on feature/x", url: null });
    expect(message).toBe("**webmux** — Agent stopped on feature/x");
  });
});

describe("resolveDiscordAgentIdentity", () => {
  it("resolves Claude's default username and avatar", () => {
    expect(resolveDiscordAgentIdentity("claude")).toEqual({
      username: "Claude",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/3840px-Claude-ai-icon.svg.png",
    });
  });

  it("resolves opencode's username with no default avatar", () => {
    expect(resolveDiscordAgentIdentity("opencode")).toEqual({ username: "OpenCode" });
  });

  it("applies an avatar override when provided", () => {
    expect(resolveDiscordAgentIdentity("opencode", { opencode: "https://example.com/opencode.png" })).toEqual({
      username: "OpenCode",
      avatarUrl: "https://example.com/opencode.png",
    });
  });

  it("returns null for a custom/unrecognized agent id", () => {
    expect(resolveDiscordAgentIdentity("my-custom-agent")).toBeNull();
  });

  it("returns null when there's no agent (branch has no session yet)", () => {
    expect(resolveDiscordAgentIdentity(null)).toBeNull();
  });
});

describe("sendDiscordAlert", () => {
  it("posts the built message to the webhook", async () => {
    const calls: Array<{ url: string; payload: DiscordWebhookPayload }> = [];
    const sender: DiscordSender = {
      post: async (url, payload) => {
        calls.push({ url, payload });
      },
    };

    await sendDiscordAlert(
      "https://discord.example/webhook",
      { projectName: "webmux", message: "Agent stopped on feature/x", url: null },
      sender,
    );

    expect(calls).toEqual([
      {
        url: "https://discord.example/webhook",
        payload: { content: "**webmux** — Agent stopped on feature/x", username: undefined, avatarUrl: undefined },
      },
    ]);
  });

  it("includes the agent's username and avatar when an identity is given", async () => {
    const calls: DiscordWebhookPayload[] = [];
    const sender: DiscordSender = {
      post: async (_url, payload) => {
        calls.push(payload);
      },
    };

    await sendDiscordAlert(
      "https://discord.example/webhook",
      {
        projectName: "webmux",
        message: "Agent stopped on feature/x",
        url: null,
        identity: { username: "Claude", avatarUrl: "https://example.com/claude.png" },
      },
      sender,
    );

    expect(calls).toEqual([
      {
        content: "**webmux** — Agent stopped on feature/x",
        username: "Claude",
        avatarUrl: "https://example.com/claude.png",
      },
    ]);
  });

  it("swallows a failed post instead of throwing", async () => {
    const sender: DiscordSender = {
      post: async () => {
        throw new Error("network down");
      },
    };

    await expect(
      sendDiscordAlert("https://discord.example/webhook", { projectName: "webmux", message: "x", url: null }, sender),
    ).resolves.toBeUndefined();
  });
});
