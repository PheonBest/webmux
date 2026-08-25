<script lang="ts">
  import { onMount } from "svelte";
  import { fetchVersionCheck, triggerUpdate } from "./api";

  const DISMISSED_VERSION_KEY = "webmux:update-banner-dismissed-version";

  let latest = $state<string | null>(null);
  let current = $state<string | null>(null);
  let dismissed = $state(false);
  let updating = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    try {
      const result = await fetchVersionCheck();
      current = result.current;
      latest = result.updateAvailable ? result.latest : null;
      dismissed = latest !== null && localStorage.getItem(DISMISSED_VERSION_KEY) === latest;
    } catch {
      latest = null;
    }
  }

  function dismiss(): void {
    dismissed = true;
    if (latest) {
      try {
        localStorage.setItem(DISMISSED_VERSION_KEY, latest);
      } catch { /* ignore storage errors */ }
    }
  }

  async function update(): Promise<void> {
    updating = true;
    error = null;
    try {
      await triggerUpdate();
    } catch (err) {
      updating = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

{#if latest && !dismissed}
  <div class="flex items-start gap-3 px-4 py-2 text-[13px] bg-surface border-b border-edge text-primary">
    <div class="flex-1 min-w-0">
      {#if updating}
        <span class="text-accent font-medium">Updating to v{latest}…</span>
        <span class="text-muted">The service will restart and reconnect shortly.</span>
      {:else}
        <span class="text-accent font-medium">webmux v{latest} is available</span>
        <span class="text-muted">(current: v{current}).</span>
        <button type="button" class="text-accent hover:underline font-medium" onclick={update}>
          Update now
        </button>
        {#if error}
          <span class="text-danger">— failed to start update: {error}</span>
        {/if}
      {/if}
    </div>
    {#if !updating}
      <button
        type="button"
        class="shrink-0 px-1 text-muted hover:text-primary"
        aria-label="Dismiss"
        onclick={dismiss}
      >
        ×
      </button>
    {/if}
  </div>
{/if}
