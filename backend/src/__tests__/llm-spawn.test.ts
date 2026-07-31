import { describe, expect, it } from "bun:test";
import { buildLlmArgs, llmProviderLabel } from "../services/llm-spawn";

describe("buildLlmArgs", () => {
  it("builds claude args with the system prompt as a flag", () => {
    const args = buildLlmArgs({ provider: "claude" }, "be terse", "name this branch");
    expect(args[0]).toBe("claude");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("be terse");
    expect(args.at(-1)).toBe("name this branch");
  });

  it("builds codex args with developer_instructions", () => {
    const args = buildLlmArgs({ provider: "codex" }, "be terse", "name this branch");
    expect(args[0]).toBe("codex");
    expect(args).toContain("exec");
    expect(args.some((arg) => arg.includes("developer_instructions"))).toBe(true);
    expect(args.at(-1)).toBe("name this branch");
  });

  it("builds opencode args, folding the system prompt into the leading message (no separate flag)", () => {
    const args = buildLlmArgs({ provider: "opencode" }, "be terse", "name this branch");
    expect(args[0]).toBe("opencode");
    expect(args).toContain("run");
    expect(args.at(-1)).toBe("be terse\n\nname this branch");
  });

  it("passes an explicit opencode model through", () => {
    const args = buildLlmArgs({ provider: "opencode", model: "opencode/grok-code" }, "be terse", "name this branch");
    expect(args).toContain("--model");
    expect(args).toContain("opencode/grok-code");
  });
});

describe("llmProviderLabel", () => {
  it("labels each provider", () => {
    expect(llmProviderLabel({ provider: "claude" })).toBe("claude");
    expect(llmProviderLabel({ provider: "codex" })).toBe("codex");
    expect(llmProviderLabel({ provider: "opencode" })).toBe("opencode");
  });
});
