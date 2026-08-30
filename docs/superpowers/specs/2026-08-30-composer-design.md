# The Composer — multi-ticket / stacked-PR orchestration

**Date:** 2026-08-30
**Status:** approved design, pending implementation plan
**Depends on:** `2026-08-30-linear-project-sidebar-filters-design.md` (the Linear
panel multi-select is specified here, deferred from that spec).

## Summary

The **composer** is a first-class webmux entry point for turning a set of Linear
issues (and/or free-form work items) into a coordinated set of worktrees and PRs.
It runs as an always-on, idle-until-prompted session on `main` (webmux's `direct`
mode). When prompted, it plans the work — splitting it into **parallel**
independent units and **dependency-ordered stacks** — presents the plan for
confirmation, then spawns one worktree per parallel unit and one worktree per
stack via a batch API. It then exits (fire-and-forget); an on-demand **resume**
re-enters supervisor mode to roll up status and rebase stacks as lower PRs merge.

The composer never implements code itself. Its job is planning, delegation, and
(on resume) supervision. Efficiency comes from keeping its own context tiny and
from child agents producing small, convention-clean, self-verified PRs.

## Goals

- One command / one prompt turns N issues into N (or fewer) coordinated worktrees.
- Correctly distinguish independent work (parallel PRs off `main`) from dependent
  work (stacked PRs), with a human confirmation step on the grouping.
- Fire-and-forget by default; `resume` for status roll-up + stack rebase.
- Works across sibling webmux projects on the same machine.
- Full parity: dashboard + CLI.
- The always-on `main` session is ready the moment a project is opened.

## Non-goals

- Autonomous merging of PRs (the human merges; resume reacts to merges).
- Replacing per-worktree agent interaction — children are normal webmux worktrees.
- Cross-machine composition.
- A bespoke dependency-analysis engine in the backend — planning is the skill's job.

## Autonomy

Configurable per invocation. Default: **plan, then wait for confirmation**. A flag
(`--auto`) or an explicit instruction ("just do it") in the prompt makes the
composer spawn immediately after planning. `integrations.composer.defaultAutonomous`
flips the default.

---

## 1. Config (`backend/src/domain/config.ts`, `adapters/config.ts`)

```ts
export interface ComposerIntegrationConfig {
  enabled: boolean;          // default true — auto-ensure the idle main session
  agent: AgentId | null;     // agent for the composer session; null → project default
  defaultAutonomous: boolean; // default false — plan-then-confirm
}
```

- Added to `IntegrationsConfig` next to `linear`.
- `DEFAULT_CONFIG.integrations.composer = { enabled: true, agent: null, defaultAutonomous: false }`.
- `parseComposerIntegration(parsed)` mirrors `parseLinearIntegration`; local-overlay
  support in `parseLocalComposerOverlay` + the merge in `loadConfig`.
- Server config payload (`buildConfigResponse` / `apiGetConfig`) exposes
  `composerEnabled: boolean` for the frontend.

## 2. Always-on composer session

### Model

The composer session **is** the `direct` session (`WorktreeMeta.direct === true`),
plus a new discriminator:

```ts
// backend/src/domain/model.ts — WorktreeMeta / ManagedWorktreeRuntimeState / snapshots
composer?: boolean; // true when this direct session was created as the composer
```

The "only one direct session at a time" invariant is unchanged and now doubles as
"only one composer session". A user manually starting a `direct` session yields a
session that is *not* `composer` — `ensureComposerSession` must treat any existing
direct session as satisfying the invariant and **not** create a second one (it may
still be used to run the composer skill; it just won't carry the pinned label).

### `composer-service.ts` (new)

```ts
export async function ensureComposerSession(deps): Promise<EnsureComposerResult>
```

- No-op if `!config.integrations.composer.enabled`.
- No-op if a `direct` session already exists (composer or not).
- Otherwise create one through the existing `worktree-creation-service` `direct`
  path with: no prompt, agent = `config.integrations.composer.agent ?? <project default>`,
  root tab label `"Composer"`, `composer: true`, agent process started (idle).
- The agent is launched with an **appended system prompt** (see §3.1).

### Wiring (`server.ts`, `session-restore-service.ts`)

- On server start, after project runtime is up: `await ensureComposerSession(...)`
  for the project.
- `session-restore-service`: after restoring sessions, if no `direct` session
  exists and composer is enabled, call `ensureComposerSession`.
- Dashboard: `apiGetProject` (first hit after boot) is an acceptable additional
  trigger point but the startup call should make it redundant; do not block the
  snapshot response on session creation — fire it and let the next poll show it.

### Dashboard rendering

The composer/direct session is pinned to the top of the worktree list with a
distinct "Composer" label + icon. (Verify whether `direct` already renders pinned;
if so, add only the icon/label distinction.) Its agent prompt box is the composer
entry point.

## 3. The composer skill (`.claude/skills/composer/`)

### Layout

```
.claude/skills/composer/
  SKILL.md                        # trigger + the 6-step flow + links to references
  references/
    plan-format.md                # ComposePlan schema, grouping rules, a worked example
    stack-choreography.md         # branch-per-stack rules, `git rebase --onto` recipes,
                                  #   how to open a stacked PR (base = the branch below)
    scoped-prompt-template.md     # how to write each child's prompt (parallel vs stack member)
  scripts/
    fetch-issues.ts               # bun: issue ids -> normalized JSON
    rebase-stack.sh               # `git rebase --onto` helper for resume
```

`SKILL.md` stays short; the detail lives in `references/`. Scripts are invoked, not
inlined, so the skill's context stays small each run.

### 3.1 Composer framing (appended system prompt)

`ensureComposerSession` launches the agent with an appended system prompt:

> You are the webmux composer for project `<name>`. When the user gives you work
> — a prompt, Linear issue ids, or both — invoke the `composer` skill and follow
> it exactly. You plan and delegate; you do not implement code yourself. Available
> sibling webmux projects: `<list>`.

`agent-service` gains a way to pass an extra system-prompt fragment when starting a
session's agent (e.g. `--append-system-prompt` for Claude; the equivalent for
other runtimes, or a seeded context file where no flag exists — decided per
runtime in the plan).

### 3.2 Flow (`SKILL.md`)

1. **Collect inputs.** The user prompt plus any Linear issue ids (passed by the
   dashboard "Compose" action or `webmux compose`). Free-form work items that are
   not tickets are allowed and become units with `linearIssueId: null`.
2. **Fetch context.** Run `scripts/fetch-issues.ts <ids…>` → normalized JSON per
   issue: `{ id, identifier, title, description, labels, project, state,
   relations }` where `relations` includes Linear "blocks"/"blocked by"/"related"
   links. Also resolve which webmux project each issue's Linear project maps to
   (by name; ask the user on ambiguity).
3. **Build the plan.** Produce a `ComposePlan` (see `references/plan-format.md`):
   - `units[]`, each `{ id, title, linearIssueId?, projectId?, dependsOn: unitId[],
     rationale }`.
   - `dependsOn` is seeded from Linear "blocked by" relations and refined by
     reading the ticket text.
   - **Grouping:** build the dependency graph over units. Each weakly-connected
     component with ≥1 edge becomes a **stack** (units topologically ordered; a
     cycle is an error — report it and ask the user to break it). Isolated units
     become **parallel**.
   - Each unit gets a scoped `prompt` (`references/scoped-prompt-template.md`): a
     parallel unit's prompt is self-contained; a stack member's prompt states its
     position in the stack, its base branch, and the stack-choreography rules
     (finish ticket, `git branch <next>`, open a stacked PR with base = branch
     below).
4. **Present + confirm.** Render the plan as a table plus an ASCII diagram
   (parallel units as siblings, stacks as vertical chains). Unless `--auto` /
   `defaultAutonomous` / an explicit "just do it", stop and let the user edit
   grouping, order, prompts, or project mapping.
5. **Spawn.** One `POST /api/compose` with the finalized `ComposePlan`. The backend
   creates one worktree per parallel unit and one worktree per stack, seeds each
   child's prompt, and arms oneshot mode for units marked `autonomous`.
6. **Report + exit.** Print the batch id, each unit's worktree + branch names, the
   stack structure, and `webmux compose resume <batch-id>` / the dashboard Resume
   button. The composer session goes idle.

### 3.3 Resume flow

Triggered by `webmux compose resume <batch-id>` or the dashboard Resume button,
both of which inject a resume prompt into the composer session.

1. `GET /api/compose/batches/:id` → per-unit agent phase + PR state (open / merged
   / closed / none).
2. For each **stack**: if the bottom-most unmerged PR has merged, rebase the rest
   of the stack onto its new base (`main` for the new bottom) via
   `POST /api/compose/batches/:id/rebase { unitId }` (which runs the extracted git
   logic; `scripts/rebase-stack.sh` is the manual fallback), then update each PR's
   base and force-push.
3. For each unit whose agent is idle and PR is not open: send a follow-up nudge
   prompt to that worktree's agent.
4. Roll up a status summary to the user. Exit.

## 4. Batch API + data model

### `packages/api-contract/src/schemas.ts`

```ts
ComposeUnitSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["parallel", "stack"]),
  linearIssueId: z.string().nullable(),
  projectId: z.string().nullable(),          // null → current project
  branch: z.string(),                        // parallel: the branch; stack: tip branch
  stackBranches: z.array(z.string()).nullable(), // stack only: ordered [base…tip], one worktree
  prompt: z.string(),
  autonomous: z.boolean(),
  baseBranch: z.string(),                    // usually "main"
});

ComposePlanSchema = z.object({
  label: z.string(),
  units: z.array(ComposeUnitSchema).min(1),
});

ComposeUnitStatusSchema = z.enum(["creating", "agent-running", "agent-idle", "pr-open", "pr-merged", "error"]);

ComposeBatchUnitSchema = ComposeUnitSchema.extend({
  worktreeBranch: z.string(),
  status: ComposeUnitStatusSchema,
  prUrl: z.string().nullable(),
});

ComposeBatchSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  units: z.array(ComposeBatchUnitSchema),
  projectRefs: z.array(z.string()),          // every webmux project the batch touched
});
```

### Endpoints (`contract.ts`, `apiPaths`)

| Method + path | Body | Response |
|---|---|---|
| `POST /api/compose` | `ComposePlanSchema` | `201 { batchId: string }` |
| `GET /api/compose/batches` | — | `200 ComposeBatchSchema[]` (batches referencing this project) |
| `GET /api/compose/batches/:id` | — | `200 ComposeBatchSchema` (fresh status) / `404` |
| `POST /api/compose/batches/:id/rebase` | `{ unitId: string }` | `200 { branches: { branch: string; sha: string }[] }` / `404` / `409` |

### Backend implementation

- **`composer-batch-service.ts`** — pure batch-state functions (create record,
  update unit status, prune) + thin file I/O to
  `~/.config/webmux/compose-batches.json` (machine-wide, since batches span
  projects). Prune a batch when all its referenced worktrees are gone.
- **`apiCompose` (`server.ts`)** — validate the plan; for each unit:
  - resolve the target project runtime (`projectId` → `project-manager`; null →
    current);
  - call the existing worktree-creation path with `branch` (or the stack tip),
    `baseBranch`, the seeded `prompt`, `fromLinear` (+ `assignToViewer`) when
    `linearIssueId` is set, and oneshot arming when `autonomous`;
  - for a `stack` unit, the child agent creates the intermediate branches itself
    per the choreography; the backend only creates the worktree on `stackBranches[0]`.
  - Record the batch, return `batchId`. Partial failure: record created units,
    return `201` with a `warnings[]` field listing the units that failed.
- **`apiComposeBatch` / `apiComposeBatches`** — read the batch record, then fan out
  across `projectRefs` runtimes to compute fresh `status` + `prUrl` per unit
  (reuse existing agent-phase + `prs` data).
- **`apiComposeRebase`** — extracted, unit-tested git logic:
  `rebaseStack(worktreePath, stackBranches, newBase)` runs `git rebase --onto` for
  each branch above the merged one, returns the new tip SHAs. `409` if the working
  tree is dirty or a rebase conflicts (surface the conflicting files).
- `readProjectSnapshot` gains `activeComposeBatches: ComposeBatch[]` (summary only)
  for the dashboard.

## 5. Cross-project mechanics

- `project-manager` already enumerates every webmux project on the machine. A
  compose unit with a foreign `projectId` has its worktree created in that
  project's runtime (its own worktree root, config, port allocation).
- The batch record and its JSON file are machine-wide; status fan-out iterates
  `projectRefs`.
- The skill needs the project list to map Linear projects → webmux projects: add
  `GET /api/projects` → `{ id, name, path }[]` (or reuse the existing instances
  endpoint if it already carries this). Mapping is by name; ambiguity or no match
  → the skill asks the user.

## 6. CLI (`bin/src`)

### `compose-commands.ts` (new)

```
webmux compose [<issue-id>…] [--prompt <text>] [--auto] [--project <name>]
webmux compose status [<batch-id>]
webmux compose resume <batch-id>
```

- `webmux compose …` resolves the target project's base URL, ensures its composer
  session exists (calls the same path the dashboard uses), then **injects a prompt**
  into that session: the issue ids + the `--prompt` text + an "autonomous" marker
  when `--auto`. CLI and dashboard therefore share exactly one code path — the
  skill does all the work.
- `webmux compose status` → `GET /api/compose/batches[/:id]`, table:
  `UNIT  KIND  WORKTREE  AGENT  PR`.
- `webmux compose resume <id>` → injects the resume prompt into the composer
  session.
- `parseComposeArgs` returns a discriminated union `{ subcommand: "run" | "status"
  | "resume", … }`. Unknown flags error. Usage text + `completions.ts` updated.

### `bin/webmux.js` routing

Register `compose` alongside `linear`, `oneshot`, `add`, etc.

## 7. Dashboard (frontend)

### Composer session

Pinned top of the worktree list with a "Composer" label + icon; its prompt box is
the entry point. `types.ts` / the worktree snapshot mapping carry the `composer`
flag.

### Linear panel multi-select (deferred from the sidebar spec)

- `LinearPanel.svelte`: a checkbox per row; when ≥1 selected, a bar appears —
  "N selected · Compose".
- "Compose" → `oncompose(issues)` → `App.svelte` focuses the composer session and
  pre-fills its prompt with the selected issue identifiers (plus a short "compose
  these" lead-in). It does **not** call `POST /api/compose` directly — the skill
  owns planning.
- `LinearPanel` props gain `selectable: boolean` + `oncompose`.

### Composed batches section

- New `ComposedBatches.svelte` (sidebar section or a panel): each batch is a group;
  parallel units listed as siblings, stacks drawn as vertical chains with the
  merge order bottom-up; per unit: status pill, worktree link, PR link; a
  "Resume" button per batch → `api.resumeCompose(batchId)`.
- `lib/api.ts`: `createCompose(plan)`, `fetchComposeBatches()`,
  `fetchComposeBatch(id)`, `rebaseComposeStack(id, unitId)`, `resumeCompose(id)`
  (the last injects the resume prompt server-side). Types in `types.ts`.
- Pure helpers in `lib/compose.ts`: group units for rendering, derive the stack
  order, map `ComposeUnitStatus` → label/colour. Unit-tested.

## 8. Dev-process hardening (prerequisite)

Ships as the **first commit** on the branch — the composer's fire-and-forget
safety depends on trusting child PRs.

- **`docs/review/agents-md-checklist.md`** — enumerated, individually checkable
  rules distilled from `AGENTS.md` + `backend/CLAUDE.md` + `frontend/CLAUDE.md`:
  - no `any`; no `as` except at a validated boundary; no `@ts-ignore` /
    `@ts-expect-error`;
  - every function signature has an explicit return type;
  - frontend components never call `fetch` — all backend calls go through
    `lib/api.ts`;
  - shared types live in `types.ts` / the module file, never duplicated inline;
  - **every user-facing option works in both the frontend and the CLI**
    (`bin/src/worktree-commands.ts` etc.) — parsing, help text, runtime handler,
    tests;
  - every new module ships a co-located `.test.ts` for its pure logic;
  - DRY: no copy-pasted UI pattern or helper — extract to a shared component /
    `lib/` util;
  - Bun-first on the backend (`Bun.env`, `Bun.file`, `Bun.spawn`, …);
  - no comments/docstrings/annotations added to untouched code.
- The `branch-diff-reviewer` agent's instructions are updated to run this
  checklist explicitly and report each violation with file:line.
- **Follow-up (not blocking):** a `.github/workflows/` job that runs the reviewer
  on PRs.

## 9. Testing

**Backend**
- `plan-grouping.test.ts` — dependency graph → weakly-connected components; topo
  order within a stack; cycle → error; isolated units → parallel.
- `ComposeUnit` / `ComposePlan` schema validation (min 1 unit, stack requires
  `stackBranches`, parallel forbids it).
- `composer-batch-service.test.ts` — record creation, unit-status transitions,
  prune when worktrees gone, machine-wide file round-trip.
- `rebase-stack.test.ts` — `rebaseStack` against a temp repo via the isolated-tmux
  harness: clean rebase updates SHAs; dirty tree / conflict → `409` with files.
- Cross-project resolution — `apiCompose` with a foreign `projectId` (mock
  `project-manager`), assert the worktree is created in the right runtime.
- `apiCompose` handler — mock worktree creation; assert N creations, oneshot
  arming for `autonomous` units, partial-failure `warnings[]`.
- `ensureComposerSession` — no-op when disabled / when a direct session exists;
  creates with the right agent + label + appended system prompt otherwise.

**Frontend**
- `lib/compose.test.ts` — render grouping, stack order, status → label/colour.
- `ComposedBatches.test.ts` — parallel vs stack rendering, Resume wiring.
- `LinearPanel.test.ts` — selection checkboxes, "Compose" bar, `oncompose` payload.
- `api.ts` — the five new calls hit the right paths.

**CLI**
- `compose-commands.test.ts` — `parseComposeArgs` for `run` / `status` / `resume`,
  repeated issue ids, `--auto`, `--project`, unknown-flag error; prompt-injection
  path (mock session send); status table formatting.

**Skill**
- `scripts/fetch-issues.ts` — output shape for a mocked Linear response
  (relations included).
- `scripts/rebase-stack.sh` — against a fixture repo.

## 10. Rollout

One branch, phased commits, each independently testable per `AGENTS.md` §4:

1. Dev-process checklist + `branch-diff-reviewer` update.
2. Config (`integrations.composer`) + `ensureComposerSession` + wiring + dashboard
   pin.
3. Batch API + data model + `composer-batch-service` + rebase logic.
4. The `composer` skill (SKILL.md + references + scripts).
5. CLI (`compose` / `compose status` / `compose resume`).
6. Dashboard (Linear multi-select → compose, `ComposedBatches`).

`integrations.composer.enabled` defaults `true`, but the feature is inert until a
prompt reaches the composer session — safe to ship dark and enable per project by
use.

## Open questions for implementation

- Which agent runtimes support an appended system prompt vs need a seeded context
  file (§3.1) — enumerate during step 2.
- Whether `direct` already renders pinned in the worktree list (§2) — check before
  adding layout code.
- Exact shape of the existing instances/projects endpoint — reuse vs add
  `GET /api/projects` (§5).
