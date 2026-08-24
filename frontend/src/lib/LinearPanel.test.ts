import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import LinearPanel from "./LinearPanel.svelte";

describe("LinearPanel", () => {
  afterEach(() => cleanup());

  it("shows a link to the project in Linear when linearProjectUrl is set", () => {
    render(LinearPanel, {
      props: {
        issues: [],
        availability: "ready",
        linearProjectUrl: "https://linear.app/example/project/webmux",
        onassign: vi.fn(),
        onselect: vi.fn(),
      },
    });

    const link = screen.getByRole("link", { name: "Open project in Linear" });
    expect(link).toHaveAttribute("href", "https://linear.app/example/project/webmux");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("hides the link when linearProjectUrl is not set", () => {
    render(LinearPanel, {
      props: {
        issues: [],
        availability: "ready",
        linearProjectUrl: null,
        onassign: vi.fn(),
        onselect: vi.fn(),
      },
    });

    expect(screen.queryByRole("link", { name: "Open project in Linear" })).not.toBeInTheDocument();
  });
});
