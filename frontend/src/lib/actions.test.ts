import { fireEvent } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { longpress } from "./actions";

describe("longpress", () => {
  let node: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    node = document.createElement("button");
    document.body.appendChild(node);
  });

  afterEach(() => {
    node.remove();
    vi.useRealTimers();
  });

  it("fires onLongPress after holding past the delay", () => {
    const onLongPress = vi.fn();
    longpress(node, { onLongPress, delay: 500 });

    fireEvent.touchStart(node);
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the touch ends before the delay", () => {
    const onLongPress = vi.fn();
    longpress(node, { onLongPress, delay: 500 });

    fireEvent.touchStart(node);
    vi.advanceTimersByTime(200);
    fireEvent.touchEnd(node);
    vi.advanceTimersByTime(1000);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does not fire when the touch moves before the delay (scroll)", () => {
    const onLongPress = vi.fn();
    longpress(node, { onLongPress, delay: 500 });

    fireEvent.touchStart(node);
    vi.advanceTimersByTime(200);
    fireEvent.touchMove(node);
    vi.advanceTimersByTime(1000);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("suppresses the click that follows a long-press", () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    node.addEventListener("click", onClick);
    longpress(node, { onLongPress, delay: 500 });

    fireEvent.touchStart(node);
    vi.advanceTimersByTime(500);
    fireEvent.click(node);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not suppress a normal click with no preceding long-press", () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    node.addEventListener("click", onClick);
    longpress(node, { onLongPress, delay: 500 });

    fireEvent.click(node);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
