import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrEntry } from "./types";
import {
  LAST_SELECTED_WORKTREE_STORAGE_KEY,
  WEB_CHAT_UI_STORAGE_KEY,
  clearWorkspaceQueryParam,
  deriveSshHost,
  loadSavedSelectedWorktree,
  loadUseWebChatUi,
  readWorkspaceQueryParam,
  resolveSelectedBranch,
  prBadgeClass,
  prStateTextClass,
  saveSelectedWorktree,
  saveUseWebChatUi,
} from "./utils";

describe("worktree selection persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the saved branch before the first successful worktree load", () => {
    expect(resolveSelectedBranch("feature/last-used", undefined, [], false)).toBe("feature/last-used");
  });

  it("keeps the current selection when that worktree still exists", () => {
    expect(
      resolveSelectedBranch(
        "feature/last-used",
        { branch: "feature/last-used" },
        [{ branch: "feature/last-used", mux: "✗" }],
        true,
      ),
    ).toBe("feature/last-used");
  });

  it("falls back to an open worktree when the saved branch is gone", () => {
    expect(
      resolveSelectedBranch(
        "feature/missing",
        undefined,
        [
          { branch: "feature/first", mux: "✗" },
          { branch: "feature/open", mux: "✓" },
        ],
        true,
      ),
    ).toBe("feature/open");
  });

  it("stores and clears the last selected worktree", () => {
    saveSelectedWorktree("feature/last-used");

    expect(loadSavedSelectedWorktree()).toBe("feature/last-used");
    expect(localStorage.getItem(LAST_SELECTED_WORKTREE_STORAGE_KEY)).toBe("feature/last-used");

    saveSelectedWorktree(null);

    expect(loadSavedSelectedWorktree()).toBeNull();
    expect(localStorage.getItem(LAST_SELECTED_WORKTREE_STORAGE_KEY)).toBeNull();
  });

  it("stores and clears the web chat UI preference", () => {
    expect(loadUseWebChatUi()).toBe(false);

    saveUseWebChatUi(true);

    expect(loadUseWebChatUi()).toBe(true);
    expect(localStorage.getItem(WEB_CHAT_UI_STORAGE_KEY)).toBe("true");

    saveUseWebChatUi(false);

    expect(loadUseWebChatUi()).toBe(false);
    expect(localStorage.getItem(WEB_CHAT_UI_STORAGE_KEY)).toBeNull();
  });
});

describe("workspace deep-link query param", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("reads the workspace param from the URL", () => {
    window.history.replaceState(null, "", "/?workspace=feature%2Fx");
    expect(readWorkspaceQueryParam()).toBe("feature/x");
  });

  it("returns null when there's no workspace param", () => {
    window.history.replaceState(null, "", "/?other=1");
    expect(readWorkspaceQueryParam()).toBeNull();
  });

  it("strips the workspace param but keeps other query params", () => {
    window.history.replaceState(null, "", "/?workspace=feature%2Fx&other=1");
    clearWorkspaceQueryParam();
    expect(window.location.search).toBe("?other=1");
  });
});

describe("PR draft styling", () => {
  const pr = (over: Partial<PrEntry>): Pick<PrEntry, "state" | "isDraft"> => ({
    state: "open",
    isDraft: false,
    ...over,
  });

  it("mutes a draft PR and keeps a ready-for-review PR highlighted", () => {
    expect(prStateTextClass(pr({ isDraft: true }))).toBe("text-muted");
    expect(prStateTextClass(pr({}))).toBe("text-primary");
  });

  it("badges a draft PR as muted and a ready-for-review PR as open", () => {
    expect(prBadgeClass(pr({ isDraft: true }))).toBe("bg-muted/20 text-muted");
    expect(prBadgeClass(pr({}))).toBe("bg-success/20 text-success");
  });

  it("keeps merged and closed colors regardless of the draft flag", () => {
    expect(prBadgeClass(pr({ state: "merged", isDraft: true }))).toBe("bg-merged/20 text-merged");
    expect(prStateTextClass(pr({ state: "closed", isDraft: true }))).toBe("text-danger");
  });
});

describe("deriveSshHost", () => {
  it("prefers an explicit setting over the browser hostname", () => {
    expect(deriveSshHost("devbox", "192.168.1.197")).toBe("devbox");
    expect(deriveSshHost("  devbox  ", "192.168.1.197")).toBe("devbox");
  });

  it("falls back to the browser hostname when no setting is configured", () => {
    expect(deriveSshHost("", "192.168.1.197")).toBe("192.168.1.197");
    expect(deriveSshHost(null, "100.81.194.124")).toBe("100.81.194.124");
    expect(deriveSshHost(undefined, "box.tail-scale.ts.net")).toBe("box.tail-scale.ts.net");
  });

  it("stays in local mode for loopback or missing hostnames", () => {
    expect(deriveSshHost("", "localhost")).toBe("");
    expect(deriveSshHost("", "127.0.0.1")).toBe("");
    expect(deriveSshHost("", "[::1]")).toBe("");
    expect(deriveSshHost("", "")).toBe("");
  });
});
