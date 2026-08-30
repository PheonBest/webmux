# webmux — project config editor + in-browser setup terminal

**Date:** 2026-08-30
**Status:** approved design, pending implementation plan
**Scope:** Two related capabilities for managing projects from the dashboard:
1. A **project configuration dialog** — a raw-YAML editor for the active
   project's `.webmux.yaml`, with strict validation and a session-restart prompt.
2. An **"Add project" in-browser terminal** — a dashboard terminal that runs a
   configurable, interactive project-setup command against a repo path.

Both are backed by a new **strict config validator** shared with the CLI.

## Background

### Config today

`backend/src/adapters/config.ts` loads `.webmux.yaml` from the project root and
overlays `.webmux.local.yaml`. Its parsers (`parseProjectConfig`, `parseProfiles`,
`parsePanes`, …) are **lenient**: unknown or malformed entries are silently
dropped and defaults substituted (e.g. a pane with `split: below` — not a valid
`PaneSplit`, which is `"right" | "bottom"` — is dropped with no signal).

Persistence helpers exist only for *local overrides*: `persistLocalLinearConfig`,
`persistLocalGitHubConfig`, `persistLocalDiscordConfig`, `persistLocalAlertsConfig`,
`persistLocalCustomAgent`, `removeLocalCustomAgent` — all write `.webmux.local.yaml`.
Nothing writes the shared `.webmux.yaml`.

`profiles.<name>.panes` (`PaneTemplate[]`) drives which panes a worktree session
opens. There is no UI or CLI surface to edit it.

### Projects today

Registry: `~/.webmux/projects.json` via `adapters/projects-registry.ts`
(`list` / `add` / `remove`, keyed by `path`). Hub routes:
`GET/POST /api/projects`, `DELETE /api/projects/:prefix`, `GET /api/projects/inits`.

`POST /api/projects` (`apiAddProject` in `server.ts`) takes `{ path }`, and when
the repo has no `.webmux.yaml` runs a **non-interactive** agent scaffold
(`runProjectInit` → `init-authoring.ts`), polled via `projectInits`.
`EmptyProjects.svelte` and `ProjectSwitcher.svelte` drive it through
`setUpProject()` in `frontend/src/lib/api.ts`. CLI: `webmux project add [path]`
(`bin/src/project-commands.ts`).

The genuinely interactive setup — `webmux init` (`bin/src/init.ts`, a `@clack`
wizard operating on `getGitRoot()`, no path argument) — is **unreachable from the
dashboard**. The user's real setup entrypoint is a personal `webmux-init` shell
alias pointing at `gloweet-meta/scripts/webmux-project-init.sh`, which runs
`webmux init`, gitignores `.webmux.local.yaml`, and runs
`webmux service install --yes` (which registers the repo).

### Terminals today

`backend/src/adapters/terminal.ts` only **attaches** to an existing *owner* tmux
session — a worktree's. `attach(attachId, target, cols, rows)` runs
`tmux new-session -d -s <grouped> -t <ownerSessionName>` then `attach-session`.
The single terminal WebSocket route is `/ws/:worktree` (`server.ts` ~line 2161),
which assumes a branch. `buildNativeTerminalLaunch` returns a command to open a
*local* terminal app — not an in-page terminal. `Terminal.svelte` renders an
xterm.js terminal over that WebSocket. Dashboard tmux sessions are named
`wm-dash-<port>-<n>` and swept on startup by `cleanupStaleSessions()`.

## Goals

- Edit the active project's `.webmux.yaml` from the dashboard as raw YAML, with
  **strict validation** (real error messages, no silent fallback) before it is
  written.
- After a successful save, if any running session uses a profile whose panes
  changed, offer to restart those sessions (reusing the existing
  `WorktreeProfileDialog` restart prompt).
- Add a project from the dashboard by running an **interactive** setup command in
  an in-page terminal, against an arbitrary repo path. The command is
  **configurable** (default `webmux init`), so the user can point it at their own
  script.
- When the setup command exits and a new project has registered itself, offer to
  open it.
- Full parity: a `webmux config` CLI command group sharing the validator.

## Non-goals

- A structured pane-builder form (add/remove/reorder rows). Raw YAML only.
- Editing `.webmux.local.yaml` from the new dialog (the existing SettingsDialog
  owns local overrides).
- Cloning a repo from a git URL. The path must already exist on disk.
- Changing the existing non-interactive `POST /api/projects` scaffold flow — it
  stays as the default "Add" action; the setup terminal is an additional option.
- Multi-project config browsing — the editor targets the *active* project only.

## Design

### 1. Strict validator — `backend/src/domain/config-validate.ts`

Pure, no I/O. One entry point:

```ts
export interface ConfigError {
  path: string;      // e.g. "profiles.default.panes[1].split"
  message: string;   // human-readable
  line?: number;     // 1-based, when the YAML lib can locate it
}

export type ValidateResult =
  | { ok: true; config: ProjectConfig }
  | { ok: false; errors: ConfigError[] };

export function validateProjectConfigYaml(text: string): ValidateResult;
```

Steps:

1. **Parse.** Use `yaml`'s `parseDocument` (not `parse`) so nodes carry
   `range`/`line` info. A syntax error → single `ConfigError` with `line`.
   Non-mapping root → `{ path: "", message: "config must be a mapping" }`.
2. **Structural checks** (collect *all* errors, don't stop at the first):
   - Unknown top-level keys (warn-level is still an error here — typos like
     `profile:` for `profiles:` must not pass silently).
   - `name`: string if present.
   - `workspace`: `mainBranch`/`worktreeRoot` strings; `defaultAgent` in
     `claude|codex|opencode`; `autoPull.intervalSeconds` a number ≥ 30.
   - `profiles`: mapping; each profile:
     - `runtime` in `host|docker` if present.
     - `envPassthrough`: string array.
     - `panes`: non-empty array; each pane:
       - `kind` in `agent|shell|command` (required).
       - `id`: string if present; **duplicate ids across the profile** → error.
       - `split` in `right|bottom` if present.
       - `sizePct`: number 1–99 if present.
       - `focus`: boolean if present; **more than one `focus: true`** → error.
       - `cwd` in `worktree|repo` if present.
       - `kind: command` ⇒ `command` non-empty string required.
       - `kind: agent|shell` with a `command` set → error (ignored field).
     - `mounts[]`: `hostPath` required non-empty.
     - `image`: string if present; `runtime: docker` with no `image` → error.
   - `services[]`: `name` + `portEnv` required strings.
   - `startupEnvs`: mapping of string|boolean.
   - `lifecycleHooks`: `postCreate`/`preRemove` strings if present.
   - `integrations`, `alerts`, `auto_name`, `oneshot`: shape checks mirroring
     the existing parsers.
3. On success, hand the already-validated object to the **existing**
   `parseProjectConfig` to produce the canonical `ProjectConfig` (single source
   of the final shape).

**Anti-drift:** the per-field predicates (`isAgentKind`, `isPaneSplit`,
`isPaneKind`, …) move into `config-validate.ts` and `adapters/config.ts` imports
them. The lenient parsers keep their fallback behaviour for old on-disk files;
they just share the predicates so "what is valid" is defined once.

Tested by `backend/src/__tests__/config-validate.test.ts` — a table of
`{ yaml, expectedErrors }` cases, plus "valid config round-trips to the same
`ProjectConfig` the parser produces".

### 2. Project configuration dialog

#### Backend

New in `adapters/config.ts`:

```ts
export function readRawProjectConfig(dir: string): { text: string; path: string; exists: boolean };
export async function persistProjectConfig(dir: string, text: string): Promise<void>; // writes .webmux.yaml
```

`readRawProjectConfig` returns the file contents, or a starter template
(`buildStarterTemplate` already exists in `init-authoring.ts`) when absent.

New per-project routes (registered alongside `apiPaths.fetchConfig` in
`server.ts`):

- `GET /api/project/config/raw`
  → `{ text: string, path: string, exists: boolean }`
- `POST /api/project/config/validate` `{ text }`
  → `{ ok: true } | { ok: false, errors: ConfigError[] }` (200 either way — this
  is the "Check" button; not a mutation)
- `PUT /api/project/config/raw` `{ text }`:
  1. `validateProjectConfigYaml(text)`; on failure → `422 { errors }`.
  2. `persistProjectConfig(PROJECT_DIR, text)`.
  3. Reload the in-memory project config (same path the config watcher uses).
  4. Compute impact: for each profile whose `panes` array changed vs. the
     previous config, list running worktree sessions currently on that profile
     (from `projectRuntime`). Respond
     `200 { affected: { profile: string; branches: string[] }[] }`.

`PROJECT_DIR` is already the per-instance project root in `server.ts`.

Contract types go in `packages/api-contract` next to the existing project types.

#### Frontend

`frontend/src/lib/ProjectConfigDialog.svelte` (uses `BaseDialog.svelte`):

- On open: `GET /api/project/config/raw` → fill a monospace `<textarea>`
  (`spellcheck=false`, tab inserts two spaces).
- **Check** button → `POST …/validate` → render `errors` as a list below the
  textarea (`path` — `message`, prefixed `line N:` when present). Green "valid"
  state on `ok`.
- **Save** button:
  - `PUT …/config/raw`.
  - `422` → render `errors`, keep dialog open, don't clear the textarea.
  - `200` with non-empty `affected` → show the restart prompt. Reuse the
    confirm-and-restart interaction from `WorktreeProfileDialog.svelte` (extract
    the shared bit into a helper if it isn't already callable) — "N session(s)
    use changed layouts. Restart them now?" → restart via the existing
    per-worktree profile-reapply endpoint, iterated over `branches`.
  - `200` with empty `affected` → toast "Saved", close.
- Entry point: a gear/⚙ button in `ProjectSwitcher.svelte` next to the active
  project row, and a link in `SettingsDialog.svelte` ("Edit project config →").

`api.ts` gains `fetchProjectConfigRaw()`, `validateProjectConfigRaw(text)`,
`saveProjectConfigRaw(text)`.

Tests: `ProjectConfigDialog.test.ts` — load, check-with-errors, save-422,
save-200-no-restart, save-200-with-restart-prompt.

### 3. "Add project" in-browser setup terminal

#### Configurable setup command

New machine-level setting `projectInitCommand`, resolved in this order:

1. `WEBMUX_PROJECT_INIT_COMMAND` env var.
2. `projectInitCommand` key in `~/.webmux/config.json` (**new** global file; a
   small typed reader/writer in a new `adapters/global-config.ts` — mirrors
   `projects-registry.ts` style, sync fs).
3. Default: `"webmux init"`.

The resolved value is a command *prefix*; the repo path is appended as a final
quoted argument. The command runs inside an **interactive** shell
(`bash -ic '<cmd> "$@"' _ <path>` on Linux, matching `detectPtyWrapper`'s shell)
so personal aliases like `webmux-init` resolve.

Exposed read-only on `GET /api/project/config` frontend config payload
(`getFrontendConfig`) as `projectInitCommand` so the UI can show what will run.

#### Standalone terminal in `terminal.ts`

Add a sibling to `attach()`:

```ts
export async function runSetupSession(input: {
  setupId: string;
  command: string;   // already includes the path arg
  cwd: string;
  cols: number;
  rows: number;
}): Promise<void>;
```

- Creates `tmux new-session -d -s wm-setup-<port>-<n> -c <cwd> <command>`
  (its own owner session, not grouped onto a worktree), then the same
  `attach-session` + `stty` tail as `buildAttachCmd`.
- Registers in the same `sessions` map so resize / input / scrollback / cleanup
  all work unchanged.
- `wm-setup-` prefix added to `cleanupStaleSessions()`.
- Exposes an `onExit` that fires when the inner command finishes (tmux session
  ends) — carries the exit code.

#### Routes

- `POST /api/setup-terminal` `{ path }`:
  - Resolve + verify `isGitRepo(path)` → `400` otherwise.
  - Snapshot `projectsRegistry.list()` paths → stash under the `setupId`.
  - `setupId = crypto.randomUUID()`; kick off `runSetupSession`.
  - `201 { setupId }`.
- `/ws/setup/:setupId` WebSocket: same handler shape as `/ws/:worktree` but keyed
  by `setupId` instead of a branch; `data.kind = "setup-terminal"`.
  On `onExit`: re-read `projectsRegistry.list()`, diff against the snapshot; if a
  new entry appeared, `reloadRoutes()` and send
  `{ type: "setup-complete", project: ProjectSummary | null, exitCode }`.
  Client can then navigate to `/<prefix>/`.

This is **hub-level** (not per-project) — it lives on the same route set as
`/api/projects`.

#### Frontend

- `EmptyProjects.svelte` / `ProjectSwitcher.svelte`: the existing path input keeps
  its "Add" button (non-interactive scaffold) and gains a secondary
  **"Add & run setup"** button.
- "Add & run setup" opens `SetupTerminalDialog.svelte` — a `BaseDialog` hosting
  `Terminal.svelte` bound to a new `setupTerminalSocket(setupId)` helper
  (thin variant of the worktree terminal socket wiring).
- On `setup-complete`: if `project` present, show "Open <name>" →
  `window.location.assign('/<prefix>/')`; else show exit code + "Close".
- `api.ts`: `createSetupTerminal(path)` → `{ setupId }`.

Tests: `SetupTerminalDialog.test.ts` (socket lifecycle, setup-complete →
open-button); backend `setup-terminal.test.ts` (session spawn with typed tmux
stub, registry-diff detects a new project, and reports none when nothing registered).

### 4. CLI parity — `bin/src/config-commands.ts`

```
webmux config show                Print the resolved .webmux.yaml path and contents
webmux config validate [path]     Validate a .webmux.yaml (defaults to the repo's);
                                   prints ConfigError list, exit 1 on any error
webmux config edit                $EDITOR the .webmux.yaml, validate on save
                                   (re-open on errors), then PUT to the live server
```

- Wired into `bin/src/webmux.ts` `RootCommand` union + dispatch, and its usage
  text.
- `validate` imports `validateProjectConfigYaml` directly (no server needed).
- `edit` / `show` reuse `readRawProjectConfig`; `edit` posts the result through
  the same `PUT /api/project/config/raw` so the running server reloads and the
  restart impact is reported in the terminal.
- The setup **terminal** has no CLI analogue — from a shell you already run
  `webmux init` (or the personal script) directly. The shared, testable piece is
  `projectInitCommand` resolution (`global-config.ts`), which both surfaces use.

Tests: `config-commands.test.ts` — `parseConfigArgs`, `validate` exit codes,
`edit` re-prompt-on-error loop with an injected editor stub.

## Data flow

```
Edit config:
  ProjectConfigDialog → GET /api/project/config/raw
  [type] → Check → POST /api/project/config/validate → ConfigError[]
  Save → PUT /api/project/config/raw
       → validateProjectConfigYaml → (422 errors) | persist + reload
       → 200 { affected[] } → restart prompt → per-branch profile reapply

Add project (setup terminal):
  EmptyProjects "Add & run setup" → POST /api/setup-terminal { path }
    → runSetupSession(tmux wm-setup-*) → { setupId }
  SetupTerminalDialog ↔ /ws/setup/:setupId  (xterm I/O, resize)
  inner command exits → registry diff → { type: "setup-complete", project }
    → "Open <name>" → navigate /<prefix>/
```

## Error handling

- Invalid YAML / structural errors: never written to disk; returned as
  `ConfigError[]`, rendered inline, dialog stays open.
- `PUT` when `.webmux.yaml` is not writable → `500 { error }`, toast, textarea
  preserved.
- `POST /api/setup-terminal` with a non-repo / missing path → `400`, shown in the
  add form, no dialog opens.
- Setup command exits non-zero and no project registered → dialog shows the exit
  code; no navigation, no registry change.
- Setup WebSocket drops mid-run → the `wm-setup-*` tmux session keeps running;
  reconnect by `setupId` is **not** supported in v1 (documented limitation) — the
  session is swept on next server start. `runSetupSession` sets a hard ceiling
  (e.g. 30 min) after which the session is killed.
- Config reload after save failing to re-parse (shouldn't happen post-validate) →
  log, keep the previous in-memory config, still report the write succeeded.

## Testing summary

| Layer | File | Covers |
|---|---|---|
| domain | `config-validate.test.ts` | good/bad YAML → errors; valid → same `ProjectConfig` as parser |
| backend | `setup-terminal.test.ts` | session spawn (tmux stub), registry-diff, exit code |
| backend | route tests in existing `server`-level suite | `PUT config/raw` 422 vs 200 + `affected` |
| frontend | `ProjectConfigDialog.test.ts` | load / check / save-422 / save-200 / restart prompt |
| frontend | `SetupTerminalDialog.test.ts` | socket wiring, setup-complete → open |
| cli | `config-commands.test.ts` | arg parse, `validate` exit codes, `edit` error loop |

## Open questions / assumptions

- `~/.webmux/config.json` is introduced as a new global-config file. If a global
  config store already lands from another effort, `projectInitCommand` moves
  there instead.
- The restart-prompt helper may need a small extraction from
  `WorktreeProfileDialog.svelte`; if that proves invasive, the dialog can call
  the same endpoint directly without sharing the component.
