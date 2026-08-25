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

  it("shows nothing when no update is available", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({ current: "0.43.1", latest: null, updateAvailable: false });

    render(UpdateBanner);

    await waitFor(() => expect(fetchVersionCheck).toHaveBeenCalled());
    expect(screen.queryByText(/is available/)).not.toBeInTheDocument();
  });

  it("shows the banner and triggers an update on click", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({ current: "0.43.1", latest: "0.44.0", updateAvailable: true });
    vi.mocked(triggerUpdate).mockResolvedValue({ ok: true });

    render(UpdateBanner);

    await screen.findByText("webmux v0.44.0 is available");

    await fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(triggerUpdate).toHaveBeenCalledTimes(1);
    await screen.findByText(/Updating to v0.44.0/);
  });

  it("stays dismissed for the same version across reloads", async () => {
    vi.mocked(fetchVersionCheck).mockResolvedValue({ current: "0.43.1", latest: "0.44.0", updateAvailable: true });

    const first = render(UpdateBanner);
    await first.findByText("webmux v0.44.0 is available");
    await fireEvent.click(first.getByLabelText("Dismiss"));
    cleanup();

    render(UpdateBanner);
    await waitFor(() => expect(fetchVersionCheck).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/is available/)).not.toBeInTheDocument();
  });
});
