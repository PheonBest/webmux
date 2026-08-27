<script lang="ts">
  import type { ThemeKey } from "./themes";
  import { SSH_STORAGE_KEY, applyTheme, errorMessage } from "./utils";
  import { THEMES } from "./themes";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";
  import Toggle from "./Toggle.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import AgentEditorDialog from "./AgentEditorDialog.svelte";
  import { api, createAgent, deleteAgent, fetchAgents, refreshVersionCheck, triggerUpdate, updateAgent, validateAgent } from "./api";
  import type { AgentDetails, AgentSummary, UpsertCustomAgentRequest } from "./types";
  import { currentPushState, disablePushNotifications, enablePushNotifications, type PushPermissionState } from "./push-notifications";

  interface AgentEditorState {
    mode: "create" | "edit";
    agentId?: string;
    title: string;
    initialValue: {
      label: string;
      startCommand: string;
      resumeCommand: string;
    };
  }

  let {
    currentTheme,
    useWebChatUi,
    linearAutoCreate,
    autoRemoveOnMerge,
    discordConfigured,
    discordNotificationsEnabled,
    fallbackNotificationDelayMinutes,
    onthemechange,
    onwebchatuichange,
    onlinearautocreatechange,
    onautoremovechange,
    ondiscordnotificationschange,
    onfallbacknotificationdelaychange,
    onagentschange,
    onsave,
    onclose,
  }: {
    currentTheme: ThemeKey;
    useWebChatUi: boolean;
    linearAutoCreate: boolean;
    autoRemoveOnMerge: boolean;
    discordConfigured: boolean;
    discordNotificationsEnabled: boolean;
    fallbackNotificationDelayMinutes: number;
    onthemechange: (key: ThemeKey) => void;
    onwebchatuichange: (enabled: boolean) => void;
    onlinearautocreatechange: (enabled: boolean) => void;
    onautoremovechange: (enabled: boolean) => void;
    ondiscordnotificationschange: (enabled: boolean) => void;
    onfallbacknotificationdelaychange: (minutes: number) => void;
    onagentschange: (agents: AgentSummary[]) => void;
    onsave: (sshHost: string) => void;
    onclose: () => void;
  } = $props();

  let sshHost = $state(localStorage.getItem(SSH_STORAGE_KEY) ?? "");
  let pendingAutoCreate = $state<boolean | null>(null);
  let autoCreate = $derived(pendingAutoCreate ?? linearAutoCreate);
  let autoCreateSaving = $state(false);

  let pendingAutoRemove = $state<boolean | null>(null);
  let autoRemove = $derived(pendingAutoRemove ?? autoRemoveOnMerge);
  let autoRemoveSaving = $state(false);

  let pendingDiscordNotifications = $state<boolean | null>(null);
  let discordNotifications = $derived(pendingDiscordNotifications ?? discordNotificationsEnabled);
  let discordNotificationsSaving = $state(false);

  let fallbackDelayDraft = $state(String(fallbackNotificationDelayMinutes));
  let fallbackDelaySaving = $state(false);
  let fallbackDelayError = $state<string | null>(null);

  let agents = $state<AgentDetails[]>([]);
  let customAgents = $derived(agents.filter((agent) => agent.kind === "custom"));
  let agentsLoading = $state(true);
  let agentsError = $state<string | null>(null);
  let agentsLoaded = false;
  let editor = $state<AgentEditorState | null>(null);
  let deleteCandidate = $state<AgentDetails | null>(null);
  let deletingAgentId = $state<string | null>(null);

  async function loadAgentList(): Promise<void> {
    agentsLoading = true;
    agentsError = null;

    try {
      agents = await fetchAgents();
    } catch (err) {
      agentsError = errorMessage(err);
    } finally {
      agentsLoading = false;
    }
  }

  function syncAgentSummaries(): void {
    api.fetchConfig()
      .then((config) => {
        onagentschange(config.agents);
      })
      .catch(() => {});
  }

  $effect(() => {
    if (agentsLoaded) return;
    agentsLoaded = true;
    void loadAgentList();
  });

  let pushState = $state<PushPermissionState>("default");
  let pushBusy = $state(false);
  let pushError = $state<string | null>(null);
  let pushStateLoaded = false;

  $effect(() => {
    if (pushStateLoaded) return;
    pushStateLoaded = true;
    void currentPushState().then((state) => (pushState = state));
  });

  async function handlePushToggle(enabled: boolean): Promise<void> {
    pushBusy = true;
    pushError = null;
    try {
      if (enabled) {
        await enablePushNotifications();
      } else {
        await disablePushNotifications();
      }
      pushState = await currentPushState();
    } catch (err) {
      pushError = errorMessage(err);
      pushState = await currentPushState();
    } finally {
      pushBusy = false;
    }
  }

  type UpdateCheckStatus = "idle" | "checking" | "up-to-date" | "available" | "error";
  let updateCheckStatus = $state<UpdateCheckStatus>("idle");
  let updateCheckMessage = $state<string | null>(null);

  async function handleCheckForUpdates(): Promise<void> {
    updateCheckStatus = "checking";
    updateCheckMessage = null;
    try {
      const result = await refreshVersionCheck();
      if (result.updateAvailable) {
        updateCheckStatus = "available";
        updateCheckMessage = `${result.commitsBehind} new commit${result.commitsBehind === 1 ? "" : "s"} on origin/main (${result.currentCommit} → ${result.latestCommit}).`;
      } else if (result.currentCommit === null) {
        updateCheckStatus = "error";
        updateCheckMessage = "Not a git-linked install — nothing to compare against origin/main.";
      } else {
        updateCheckStatus = "up-to-date";
        updateCheckMessage = `Up to date (${result.currentCommit}).`;
      }
    } catch (err) {
      updateCheckStatus = "error";
      updateCheckMessage = errorMessage(err);
    }
  }

  async function handleUpdateNow(): Promise<void> {
    updateCheckMessage = "Updating — the service will restart and reconnect shortly.";
    try {
      await triggerUpdate();
    } catch (err) {
      updateCheckStatus = "error";
      updateCheckMessage = errorMessage(err);
    }
  }

  function handleAutoCreateToggle(enabled: boolean) {
    pendingAutoCreate = enabled;
    autoCreateSaving = true;
    api.setLinearAutoCreate({ body: { enabled } })
      .then((result) => {
        onlinearautocreatechange(result.enabled);
      })
      .finally(() => {
        pendingAutoCreate = null;
        autoCreateSaving = false;
      });
  }

  function handleAutoRemoveToggle(enabled: boolean) {
    pendingAutoRemove = enabled;
    autoRemoveSaving = true;
    api.setAutoRemoveOnMerge({ body: { enabled } })
      .then((result) => {
        onautoremovechange(result.enabled);
      })
      .finally(() => {
        pendingAutoRemove = null;
        autoRemoveSaving = false;
      });
  }

  function handleDiscordNotificationsToggle(enabled: boolean) {
    pendingDiscordNotifications = enabled;
    discordNotificationsSaving = true;
    api.setDiscordNotifications({ body: { enabled } })
      .then((result) => {
        ondiscordnotificationschange(result.enabled);
      })
      .finally(() => {
        pendingDiscordNotifications = null;
        discordNotificationsSaving = false;
      });
  }

  function handleFallbackDelayBlur() {
    const minutes = Number(fallbackDelayDraft);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      fallbackDelayError = "Enter a number of minutes greater than 0.";
      fallbackDelayDraft = String(fallbackNotificationDelayMinutes);
      return;
    }
    fallbackDelayError = null;
    if (minutes === fallbackNotificationDelayMinutes) return;

    fallbackDelaySaving = true;
    api.setFallbackNotificationDelay({ body: { minutes } })
      .then((result) => {
        fallbackDelayDraft = String(result.minutes);
        onfallbacknotificationdelaychange(result.minutes);
      })
      .catch((err) => {
        fallbackDelayError = errorMessage(err);
        fallbackDelayDraft = String(fallbackNotificationDelayMinutes);
      })
      .finally(() => {
        fallbackDelaySaving = false;
      });
  }

  function handleSave() {
    const trimmed = sshHost.trim();
    if (trimmed) {
      localStorage.setItem(SSH_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(SSH_STORAGE_KEY);
    }
    onsave(trimmed);
  }

  function selectTheme(key: ThemeKey) {
    applyTheme(key);
    onthemechange(key);
  }

  function openCreateAgentEditor(): void {
    editor = {
      mode: "create",
      title: "Add custom agent",
      initialValue: {
        label: "",
        startCommand: "",
        resumeCommand: "",
      },
    };
  }

  function openEditAgentEditor(agent: AgentDetails): void {
    editor = {
      mode: "edit",
      agentId: agent.id,
      title: `Edit ${agent.label}`,
      initialValue: {
        label: agent.label,
        startCommand: agent.startCommand ?? "",
        resumeCommand: agent.resumeCommand ?? "",
      },
    };
  }

  function openDuplicateAgentEditor(agent: AgentDetails): void {
    editor = {
      mode: "create",
      title: `Duplicate ${agent.label}`,
      initialValue: {
        label: `${agent.label} Copy`,
        startCommand: agent.startCommand ?? "",
        resumeCommand: agent.resumeCommand ?? "",
      },
    };
  }

  async function handleSaveAgent(input: UpsertCustomAgentRequest): Promise<void> {
    if (!editor) return;

    if (editor.mode === "edit" && editor.agentId) {
      await updateAgent(editor.agentId, input);
    } else {
      await createAgent(input);
    }

    await loadAgentList();
    syncAgentSummaries();
    editor = null;
  }

  function handleValidateAgent(input: UpsertCustomAgentRequest) {
    return validateAgent(input);
  }

  async function handleDeleteAgent(): Promise<void> {
    if (!deleteCandidate) return;
    deletingAgentId = deleteCandidate.id;

    try {
      await deleteAgent(deleteCandidate.id);
      await loadAgentList();
      syncAgentSummaries();
      deleteCandidate = null;
    } finally {
      deletingAgentId = null;
    }
  }
</script>

<BaseDialog {onclose} wide>
  <form onsubmit={(event) => { event.preventDefault(); handleSave(); }}>
    <h2 class="text-base mb-4">Settings</h2>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Theme</span>
      <div class="grid grid-cols-2 gap-2">
        {#each THEMES as theme (theme.key)}
          <button
            type="button"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md border cursor-pointer text-left text-[13px] transition-colors {currentTheme === theme.key
              ? 'border-accent bg-active text-primary'
              : 'border-edge bg-surface text-muted hover:bg-hover hover:text-primary'}"
            onclick={() => selectTheme(theme.key)}
          >
            <span class="shrink-0 flex gap-0.5">
              {#each [theme.colors.surface, theme.colors.accent, theme.colors.success, theme.colors.warning] as color}
                <span class="w-3 h-3 rounded-full border border-edge" style="background:{color}"></span>
              {/each}
            </span>
            <span>{theme.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Interface</span>
      <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
        <div>
          <span class="text-[13px] text-primary">Use web chat UI</span>
          <p class="text-[11px] text-muted mt-0.5">
            Show the in-app agent conversation instead of the terminal for supported agents.
          </p>
        </div>

        <Toggle
          checked={useWebChatUi}
          ontoggle={onwebchatuichange}
          aria-label="Use web chat UI"
        />
      </div>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Agents</span>
      <div class="rounded-lg border border-edge bg-surface/40 p-3">
        <div class="mb-3 flex items-center justify-between gap-2">
          <div>
            <p class="text-[13px] text-primary">Custom agents</p>
            <p class="mt-0.5 text-[11px] text-muted">
              Add terminal agents that webmux can launch from the dashboard.
            </p>
          </div>
          <Btn type="button" variant="cta" onclick={openCreateAgentEditor}>Add agent</Btn>
        </div>

        {#if agentsLoading}
          <p class="text-[12px] text-muted">Loading agents...</p>
        {:else if agentsError}
          <p class="text-[12px] text-danger">{agentsError}</p>
        {:else}
          {#if customAgents.length === 0}
            <p class="text-[12px] text-muted">No custom agents setup</p>
          {:else}
            <div class="space-y-2">
              {#each customAgents as agent (agent.id)}
                <div class="rounded-lg border border-edge bg-surface px-3 py-2.5">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-[13px] text-primary">{agent.label}</span>
                      </div>
                      <p class="mt-1 text-[11px] text-muted font-mono break-all">
                        {agent.startCommand}
                      </p>
                      {#if agent.resumeCommand}
                        <p class="mt-1 text-[11px] text-muted font-mono break-all">
                          Resume: {agent.resumeCommand}
                        </p>
                      {/if}
                    </div>

                    <div class="flex shrink-0 gap-2 text-[11px]">
                      <button type="button" class="text-accent hover:underline" onclick={() => openEditAgentEditor(agent)}>
                        Edit
                      </button>
                      <button type="button" class="text-accent hover:underline" onclick={() => openDuplicateAgentEditor(agent)}>
                        Duplicate
                      </button>
                      <button
                        type="button"
                        class="text-danger hover:underline disabled:opacity-60"
                        disabled={deletingAgentId === agent.id}
                        onclick={() => (deleteCandidate = agent)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Notifications</span>
      <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
        <div>
          <span class="text-[13px] text-primary">Push notifications</span>
          <p class="text-[11px] text-muted mt-0.5">
            {#if pushState === "unsupported"}
              Not supported in this browser.
            {:else if pushState === "denied"}
              Blocked — allow notifications for this site in your browser settings.
            {:else}
              Get notified on this device when an agent stops, opens a PR, or hits an error.
            {/if}
          </p>
          {#if pushError}
            <p class="text-[11px] text-danger mt-0.5">{pushError}</p>
          {/if}
        </div>

        <Toggle
          checked={pushState === "subscribed"}
          disabled={pushBusy || pushState === "unsupported" || pushState === "denied"}
          ontoggle={handlePushToggle}
          aria-label="Push notifications"
        />
      </div>
      <div class="flex items-center justify-between gap-3 px-3 py-2 mt-2 rounded-md border border-edge bg-surface">
        <div>
          <span class="text-[13px] text-primary">Discord notifications</span>
          <p class="text-[11px] text-muted mt-0.5">
            {#if !discordConfigured}
              Not configured — set DISCORD_WEBHOOK_URL to enable.
            {:else}
              Post the same alerts to your Discord channel.
            {/if}
          </p>
        </div>

        <Toggle
          checked={discordNotifications}
          disabled={discordNotificationsSaving || !discordConfigured}
          ontoggle={handleDiscordNotificationsToggle}
          aria-label="Discord notifications"
        />
      </div>
      <div class="flex items-center justify-between gap-3 px-3 py-2 mt-2 rounded-md border border-edge bg-surface">
        <div>
          <span class="text-[13px] text-primary">Fallback alert delay</span>
          <p class="text-[11px] text-muted mt-0.5">
            Alert anyway if a worktree sits stopped or waiting on you this long with nothing else sent.
          </p>
          {#if fallbackDelayError}
            <p class="text-[11px] text-danger mt-0.5">{fallbackDelayError}</p>
          {/if}
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <input
            type="number"
            min="1"
            step="1"
            class="w-14 px-2 py-1 rounded-md border border-edge bg-bg text-[13px] text-primary text-right"
            aria-label="Fallback alert delay in minutes"
            disabled={fallbackDelaySaving}
            bind:value={fallbackDelayDraft}
            onblur={handleFallbackDelayBlur}
            onkeydown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
          />
          <span class="text-[12px] text-muted">min</span>
        </div>
      </div>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Updates</span>
      <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
        <div class="min-w-0">
          <span class="text-[13px] text-primary">Check for updates</span>
          <p class="text-[11px] mt-0.5 {updateCheckStatus === 'error' ? 'text-danger' : 'text-muted'}">
            {updateCheckMessage ?? "Compares this build against origin/main."}
          </p>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          {#if updateCheckStatus === "available"}
            <Btn small variant="cta" onclick={handleUpdateNow}>Update now</Btn>
          {/if}
          <Btn small onclick={handleCheckForUpdates} disabled={updateCheckStatus === "checking"}>
            {updateCheckStatus === "checking" ? "Checking…" : "Check for updates"}
          </Btn>
        </div>
      </div>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Linear</span>
      <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
        <div>
          <span class="text-[13px] text-primary">Auto-create worktrees</span>
          <p class="text-[11px] text-muted mt-0.5">
            Automatically create worktrees for Todo Linear tickets with the "webmux" label.
          </p>
        </div>

        <Toggle
          checked={autoCreate}
          disabled={autoCreateSaving}
          ontoggle={handleAutoCreateToggle}
          aria-label="Auto-create worktrees for Linear tickets"
        />
      </div>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">GitHub</span>
      <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
        <div>
          <span class="text-[13px] text-primary">Auto-remove on merge</span>
          <p class="text-[11px] text-muted mt-0.5">
            Automatically remove worktrees when their PR is merged on GitHub.
          </p>
        </div>

        <Toggle
          checked={autoRemove}
          disabled={autoRemoveSaving}
          ontoggle={handleAutoRemoveToggle}
          aria-label="Auto-remove worktrees on PR merge"
        />
      </div>
    </div>

    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="ssh-host">
        SSH Host <span class="opacity-60">(for "Open in VS Code / Cursor")</span>
      </label>
      <input
        id="ssh-host"
        type="text"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
        placeholder="e.g. devbox or 10.0.0.5"
        bind:value={sshHost}
      />
      <p class="text-[11px] text-muted mt-1.5">
        Should match an entry in your local <code class="text-accent/80">~/.ssh/config</code>. Leave empty to use the address you're accessing webmux from.
      </p>
    </div>
    <div class="flex justify-end gap-2">
      <Btn type="button" onclick={onclose}>Cancel</Btn>
      <Btn type="submit" variant="cta">Save</Btn>
    </div>
  </form>
</BaseDialog>

{#if editor}
  <AgentEditorDialog
    title={editor.title}
    initialValue={editor.initialValue}
    onsave={handleSaveAgent}
    onvalidate={handleValidateAgent}
    onclose={() => (editor = null)}
  />
{/if}

{#if deleteCandidate}
  <ConfirmDialog
    message={`Delete agent "${deleteCandidate.label}"?`}
    onconfirm={() => {
      void handleDeleteAgent();
    }}
    oncancel={() => {
      deleteCandidate = null;
    }}
  />
{/if}
