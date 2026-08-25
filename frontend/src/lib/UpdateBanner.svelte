<script lang="ts">
  import { onMount } from "svelte";
  import { fetchVersionCheck, triggerUpdate } from "./api";

  const DISMISSED_COMMIT_KEY = "webmux:update-banner-dismissed-commit";

  let latestCommit = $state<string | null>(null);
  let currentCommit = $state<string | null>(null);
  let commitsBehind = $state(0);
  let dismissed = $state(false);
  let updating = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    try {
      const result = await fetchVersionCheck();
      currentCommit = result.currentCommit;
      commitsBehind = result.commitsBehind;
      latestCommit = result.updateAvailable ? result.latestCommit : null;
      dismissed = latestCommit !== null && localStorage.getItem(DISMISSED_COMMIT_KEY) === latestCommit;
    } catch {
      latestCommit = null;
    }
  }

  function dismiss(): void {
    dismissed = true;
    if (latestCommit) {
      try {
        localStorage.setItem(DISMISSED_COMMIT_KEY, latestCommit);
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

{#if latestCommit && !dismissed}
  <div class="flex items-start gap-3 px-4 py-2 text-[13px] bg-surface border-b border-edge text-primary">
    <div class="flex-1 min-w-0">
      {#if updating}
        <span class="text-accent font-medium">Updating to {latestCommit}…</span>
        <span class="text-muted">The service will restart and reconnect shortly.</span>
      {:else}
        <span class="text-accent font-medium">
          {commitsBehind} new commit{commitsBehind === 1 ? "" : "s"} on origin/main
        </span>
        <span class="text-muted">(current: {currentCommit}, latest: {latestCommit}).</span>
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
