export interface LongPressOptions {
  onLongPress: () => void;
  /** ms to hold before firing. Default 500. */
  delay?: number;
}

/** Svelte action: fires `onLongPress` after a sustained touch hold, and
 *  swallows the click that would otherwise follow (so a long-press doesn't
 *  also trigger the element's normal tap action). Touch-only — desktop mouse
 *  interaction is untouched, since it already has hover/right-click. */
export function longpress(node: HTMLElement, options: LongPressOptions) {
  let opts = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firedAt = 0;

  function clear(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function start(): void {
    clear();
    timer = setTimeout(() => {
      timer = null;
      firedAt = Date.now();
      opts.onLongPress();
    }, opts.delay ?? 500);
  }

  // Capture phase so this runs before the element's own click handler.
  function suppressFollowingClick(event: Event): void {
    if (Date.now() - firedAt < 500) {
      event.stopPropagation();
      event.preventDefault();
    }
  }

  node.addEventListener("touchstart", start, { passive: true });
  node.addEventListener("touchend", clear);
  node.addEventListener("touchmove", clear);
  node.addEventListener("touchcancel", clear);
  node.addEventListener("click", suppressFollowingClick, true);

  return {
    update(next: LongPressOptions): void {
      opts = next;
    },
    destroy(): void {
      clear();
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchend", clear);
      node.removeEventListener("touchmove", clear);
      node.removeEventListener("touchcancel", clear);
      node.removeEventListener("click", suppressFollowingClick, true);
    },
  };
}
