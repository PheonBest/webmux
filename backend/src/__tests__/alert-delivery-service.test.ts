import { describe, expect, it } from "bun:test";
import {
  buildDiscordMessage,
  buildWorkspaceDeepLink,
  sendDiscordAlert,
  type DiscordSender,
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

describe("sendDiscordAlert", () => {
  it("posts the built message to the webhook", async () => {
    const calls: Array<{ url: string; content: string }> = [];
    const sender: DiscordSender = {
      post: async (url, content) => {
        calls.push({ url, content });
      },
    };

    await sendDiscordAlert(
      "https://discord.example/webhook",
      { projectName: "webmux", message: "Agent stopped on feature/x", url: null },
      sender,
    );

    expect(calls).toEqual([
      { url: "https://discord.example/webhook", content: "**webmux** — Agent stopped on feature/x" },
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
