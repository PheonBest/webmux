import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fetchVersionCheck: vi.fn(),
  triggerUpdate: vi.fn(),
}));

import UpdateBanner from "./UpdateBanner.svelte";
import { fetchVersionCheck, triggerUpdate } from "./api";

describe("UpdateBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => cleanup());

  it("shows a reload prompt and skips the git check when reloadRequired is set", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({
      currentCommit: "abc1234",
      latestCommit: null,
      commitsBehind: 0,
      updateAvailable: false,
    });
    const reloadSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadSpy });

    render(UpdateBanner, { reloadRequired: true });

    expect(await screen.findByText(/new version was deployed/i)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloadSpy).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("shows nothing when no update is available", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({
      currentCommit: "abc1234",
      latestCommit: null,
      commitsBehind: 0,
      updateAvailable: false,
    });

    render(UpdateBanner);

    await waitFor(() => expect(fetchVersionCheck).toHaveBeenCalled());
    expect(screen.queryByText(/new commit/)).not.toBeInTheDocument();
  });

  it("shows the banner and triggers an update on click", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({
      currentCommit: "abc1234",
      latestCommit: "def5678",
      commitsBehind: 3,
      updateAvailable: true,
    });
    vi.mocked(triggerUpdate).mockResolvedValue({ ok: true });

    render(UpdateBanner);

    await screen.findByText("3 new commits on origin/main");

    await fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(triggerUpdate).toHaveBeenCalledTimes(1);
    await screen.findByText(/Updating to def5678/);
  });

  it("stays dismissed for the same commit across reloads", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({
      currentCommit: "abc1234",
      latestCommit: "def5678",
      commitsBehind: 1,
      updateAvailable: true,
    });

    const first = render(UpdateBanner);
    await first.findByText("1 new commit on origin/main");
    await fireEvent.click(first.getByLabelText("Dismiss"));
    cleanup();

    render(UpdateBanner);
    await waitFor(() => expect(fetchVersionCheck).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/new commit/)).not.toBeInTheDocument();
  });
});
