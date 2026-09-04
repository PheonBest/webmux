# Linear project sidebar — status/assignee filters

**Date:** 2026-08-30
**Status:** approved design, pending implementation plan
**Scope:** Replace the "assigned Linear issues" sidebar panel with a project-scoped,
filterable issue list. Auto-assign issues to the current user when implementation
starts. Multi-select of issues is **out of scope here** — it ships with the
"composer" (multi-ticket / stacked-PR orchestration), a separate spec.

## Background

Today the Linear sidebar is driven by one hard-coded GraphQL query,
`ASSIGNED_ISSUES_QUERY` (`backend/src/services/linear-service.ts`), which fetches
`viewer.assignedIssues` (non-done, `orderBy: updatedAt`, `first: 50`), cached
in-process 5 min. `GET /api/linear/issues` returns `{ availability, issues[] }`
with no parameters. `LinearPanel.svelte` renders a collapsible section with a
client-side text search. `LINEAR_PROJECT_URL` is currently used only to render an
external-link icon.

The project snapshot (`GET /api/project`) separately calls `fetchAssignedIssues()`
to match branches to issues for the per-worktree issue badge — **this stays
unchanged.**

## Goals

- Sidebar shows issues for a chosen Linear **project**, filterable by **status**
  (multi) and **assignee** (single), sorted by **priority**.
- Default filter: project from `LINEAR_PROJECT_URL`, status `["Todo"]`, assignee
  none. Filter persists in `localStorage`, keyed per webmux project.
- Clearing the project pill → all workspace issues (capped 50).
- Each row shows the assignee.
- Starting implementation of an issue from webmux auto-assigns that issue to the
  current user (best-effort).
- Full parity: frontend + CLI.

## Non-goals

- Multi-select / multi-implement (→ composer spec).
- Stacked PRs (→ composer spec).
- Changing the per-worktree issue badge or `fetchAssignedIssues`.
- Creating/editing issues beyond the assignee update.

## Approach

Server-side filtering via Linear's GraphQL `IssueFilter` (approach A). Rejected:
fetch-all + client-side filter (the "all workspace" mode is unbounded), hybrid
(same problem, plus the option lists still need their own queries).

## Data model & API contract (`packages/api-contract/src`)

### Schema changes

`LinearIssueSchema` — add:

```ts
assignee: z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
}).nullable()
```

New schemas:

```ts
LinearFilterOptionsResponseSchema = z.object({
  viewerId: z.string(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  users: z.array(z.object({ id: z.string(), name: z.string(), displayName: z.string() })),
  statuses: z.array(z.object({
    name: z.string(), color: z.string(), type: z.string(), position: z.number(),
  })),
})
```

`statuses` is the set of workflow-state **names** across the workspace,
de-duplicated by name (keeping the minimum `position` and the first `color`/`type`
seen), sorted ascending by `position`.

### Endpoint changes (`contract.ts`, `apiPaths`)

- `fetchLinearIssues` gains a `query` schema:
  - `project?: string` — Linear project id. Omitted ⇒ all-workspace.
  - `statuses?: string` — comma-separated state names. Omitted ⇒ no status filter.
  - `assignee?: string` — Linear user id, or the literal `"me"`. Omitted ⇒ any.
  - Response shape unchanged: `LinearIssuesResponseSchema`.
- New `fetchLinearFilterOptions`: `GET /api/linear/filter-options` →
  `200: LinearFilterOptionsResponseSchema`, `500`/`502: ErrorResponseSchema`.
- `CreateWorktreeRequest.fromLinear` gains `assignToViewer?: boolean`.

## Backend (`backend/src`)

### `services/linear-service.ts`

New GraphQL documents:

- `PROJECT_ISSUES_QUERY($filter: IssueFilter!, $first: Int!)` — selects
  `issues(filter: $filter, orderBy: updatedAt, first: $first)` with the same node
  fields as today plus `assignee { id name displayName avatarUrl }`.
- `FILTER_OPTIONS_QUERY` — `viewer { id }`, `projects(first: 250) { nodes { id name } }`,
  `users(first: 250, filter: { active: { eq: true } }) { nodes { id name displayName } }`,
  `workflowStates(first: 250) { nodes { name color type position } }`.
- `ISSUE_SET_ASSIGNEE_MUTATION($id: String!, $assigneeId: String!)` —
  `issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }`.

New pure functions (all unit-tested, no I/O):

| Function | Responsibility |
|---|---|
| `buildIssueFilter(input: { projectId?: string; statusNames?: string[]; assigneeId?: string })` | Returns a Linear `IssueFilter` object. `projectId` ⇒ `project: { id: { eq } }`. `statusNames` non-empty ⇒ `state: { name: { in } }`; empty/absent ⇒ `state: { type: { nin: ["completed","canceled"] } }`. `assigneeId` ⇒ `assignee: { id: { eq } }`. |
| `sortIssuesByPriority(issues)` | Sort ascending by `priority === 0 ? 5 : priority`, tiebreak `updatedAt` descending. Pure, returns new array. |
| `parseProjectIssuesResponse(raw)` | Like `parseIssuesResponse` + maps `assignee` (null-safe). Returns `FetchIssuesResult`. |
| `parseFilterOptionsResponse(raw)` | GraphQL-error check → `{ ok, data: LinearFilterOptionsResponse }`. Calls `dedupeStatesByName`. |
| `dedupeStatesByName(nodes)` | Collapse by name (min position, first color/type), sort by position. |
| `parseIssueSetAssigneeResponse(raw)` | `{ ok: true } \| { ok: false, error }`. |

New I/O functions:

- `fetchProjectIssues(filter, opts?): Promise<FetchIssuesResult>` — builds filter,
  posts `PROJECT_ISSUES_QUERY` with `first: 50`, parses, `sortIssuesByPriority`,
  caches. **Cache:** `Map<string, { data, expiry }>` keyed by
  `JSON.stringify(filter)`, TTL 60_000 ms, cap 20 entries (evict oldest). Cleared
  by `resetLinearCaches()`.
- `fetchLinearFilterOptions(): Promise<{ ok, data } | { ok, error }>` — single
  global cache, TTL 300_000 ms, cleared by `resetLinearCaches()`.
- `assignIssueToViewer(issueIdOrIdentifier): Promise<{ ok } | { ok, error }>` —
  `fetchViewerId()`, then resolve the issue id if an identifier was passed
  (`fetchIssueWithAttachments` already returns `.id`), then post
  `ISSUE_SET_ASSIGNEE_MUTATION`. On success, invalidate the project-issues cache.

`resetLinearCaches()` extended to clear the two new caches.

### `server.ts`

- `apiGetLinearIssues` (the `fetchLinearIssues` handler) — read `project`,
  `statuses` (split on `,`, trim, drop empties), `assignee` from the query.
  Resolve `assignee === "me"` → viewer id via `fetchLinearFilterOptions()` (or a
  cached `fetchViewerId()`). Gate on `config.integrations.linear.enabled` +
  `LINEAR_API_KEY` exactly as today via `buildLinearIssuesResponse` (pass the
  `fetchProjectIssues` result as `fetchResult`).
- New `apiGetLinearFilterOptions` handler → `fetchLinearFilterOptions()`,
  `jsonResponse` or `errorResponse(error, 502)`. Same enabled/api-key gate; when
  disabled or missing key, return `{ viewerId: "", projects: [], users: [], statuses: [] }`
  with `200` (frontend already handles `availability` separately).
- Wire both routes in the request router.
- In `apiCreateWorktree`, `body.fromLinear` branch: after the seed resolves, if
  `body.fromLinear.assignToViewer`, call `assignIssueToViewer(body.fromLinear.issueId)`.
  Best-effort: on `!ok`, `log.warn` and continue — never fail creation.

## Frontend (`frontend/src`)

### `lib/types.ts`

Re-export `LinearFilterOptionsResponse`, and the updated `LinearIssue`.

### `lib/linear-filter.ts` (new, pure — unit-tested)

```ts
export interface LinearFilterState {
  projectId: string | null;
  statusNames: string[];
  assigneeId: string | null; // Linear user id, or "me", or null
}

export const DEFAULT_STATUS_NAMES = ["Todo"];

export function makeDefaultFilter(
  options: LinearFilterOptionsResponse | null,
  linearProjectUrl: string | null,
): LinearFilterState;

export function resolveDefaultProjectId(
  options: LinearFilterOptionsResponse | null,
  linearProjectUrl: string | null,
): string | null; // match a project whose name (slugified) appears in the URL path

export function loadPersistedFilter(projectKey: string): LinearFilterState | null;
export function persistFilter(projectKey: string, filter: LinearFilterState): void;
// localStorage key: `webmux:linear-filter:${projectKey}`, projectKey = config.name
export function filterToQuery(filter: LinearFilterState): {
  project?: string; statuses?: string; assignee?: string;
};
```

`resolveDefaultProjectId`: Linear project URLs look like
`https://linear.app/<ws>/project/<slug>-<shortid>/...`. Slugify each option name
(`lowercase`, non-alnum → `-`) and pick the option whose slug is a substring of
the URL path. No match ⇒ `null` (all-workspace).

### `lib/api.ts`

```ts
export function fetchLinearIssues(filter?: LinearFilterState): Promise<LinearIssuesResponse>
export function fetchLinearFilterOptions(): Promise<LinearFilterOptionsResponse>
```

`fetchLinearIssues` passes `filterToQuery(filter)` as the request `query`.

### `LinearPanel.svelte` (rewrite)

Props:

```ts
{
  issues: LinearIssue[];
  availability: LinearIssueAvailability;
  options: LinearFilterOptionsResponse | null;
  filter: LinearFilterState;              // not bindable; changes flow via onfilterchange
  linearProjectUrl: string | null;
  onfilterchange: (next: LinearFilterState) => void;
  onassign: (issue: LinearIssue) => void; // single-issue, unchanged semantics
  onselect: (issue: LinearIssue) => void;
}
```

Layout:

- Header: `Linear (n)` + external-link icon (unchanged).
- **Filter-pill row** (below header, above search), three pills:
  - **Project** — label = project name or `All workspace`. Dropdown: radio list
    `All workspace` + every `options.projects`. `✕` when a project is set →
    `projectId: null`.
  - **Status** — label = first name + `+N` when `statusNames.length > 1`, or
    `Any status` when empty. Dropdown: checkbox per `options.statuses` (already
    position-sorted). `✕` → `statusNames: []`.
  - **Assignee** — label = `Anyone` / `Me` / the user's `displayName`. Dropdown:
    radio `Anyone`, `Me`, then `options.users`. `✕` → `assigneeId: null`.
  - Each change calls `onfilterchange` with the next state. Dropdown is a
    lightweight popover (reuse the existing menu/popover pattern if one exists;
    otherwise a `<div>` toggled by a button with outside-click close).
- **Search box** — retained, client-side `searchMatch` over title/description on
  top of the server results.
- **Rows** — same visual structure as today plus, on the right of the meta line,
  an assignee chip: `avatarUrl` image if present, else initials from
  `displayName`; tooltip = `displayName`; nothing when unassigned. Rows arrive
  pre-sorted by priority from the server (no client sort).
- Availability branches (`missing_api_key`, `disabled`, empty) — keep today's
  copy; the empty-state message becomes "No issues match this filter."

### `App.svelte`

- On config load, also `api.fetchLinearFilterOptions()` → `linearFilterOptions = $state(...)`.
- `linearFilter = $state(loadPersistedFilter(config.name) ?? makeDefaultFilter(linearFilterOptions, config.linearProjectUrl))`.
  Because options may resolve after the first render, run one `$effect` that, if
  `linearFilter.projectId === null` **and** nothing was persisted **and** options
  just arrived, upgrades to `makeDefaultFilter(...)` once.
- `refreshLinear()` calls `api.fetchLinearIssues(linearFilter)`; keep the existing
  `LINEAR_THROTTLE_MS` throttle.
- `handleFilterChange(next)`: `linearFilter = next`; `persistFilter(config.name, next)`;
  `refreshLinear()` (bypassing throttle for an explicit user change).
- `handleAssignIssue` unchanged, but the `fromLinear` request it builds now sets
  `assignToViewer: true`.
- Pass `options={linearFilterOptions}`, `filter={linearFilter}`,
  `onfilterchange={handleFilterChange}` into `<LinearPanel>`.

## CLI (`bin/src`)

### `linear-commands.ts`

New subcommand `webmux linear issues`:

```
webmux linear issues [--project <name|id>] [--status <name>]... [--assignee <me|name>] [--json]
```

- `parseLinearArgs` accepts `issues` alongside `post`; new
  `ParsedLinearIssuesCommand { subcommand: "issues"; project: string | null;
  statuses: string[]; assignee: string | null; json: boolean }`.
- `--status` repeatable; `--project` / `--assignee` single; unknown flags error.
- `runLinearCommand`: for `issues`, GET `/api/linear/filter-options`, resolve
  `--project` (exact id match, else case-insensitive name match, else usage
  error), resolve `--assignee` (`me` passes through; else name → user id). When no
  flags given, default to `--status Todo` and project =
  `resolveDefaultProjectId(options, LINEAR_PROJECT_URL)` (read
  `LINEAR_PROJECT_URL` from env in the CLI process — it runs on the same host).
- GET `/api/linear/issues` with the resolved query.
- Output: `--json` prints the raw issues array; otherwise a table —
  `IDENTIFIER  PRIORITY  STATUS  ASSIGNEE  TITLE` (truncate title to terminal
  width), priority rendered as its label.
- `getLinearUsage()` updated; `completions.ts` gains `issues` + its flags.

### `worktree-commands.ts`

`webmux add --from-linear <id>` gains `--assign-me` → sets
`fromLinear.assignToViewer: true` in the create request. Update parsing, help
text, runtime handler.

## Error handling

- Linear API / GraphQL errors on the issues endpoint → `502` with the message,
  same as today's `buildLinearIssuesResponse` contract.
- `filter-options` failure → `502`; the panel falls back to empty option lists,
  pills still render (just with no choices) and the issue list still works with
  whatever filter is persisted.
- `assignIssueToViewer` failure → logged, swallowed; worktree creation proceeds.
- `assignee === "me"` when the viewer id can't be resolved → treat as "any"
  (log a warning).

## Testing

**Backend (`__tests__/linear-service.test.ts`):**
- `buildIssueFilter` — each dimension present/absent, empty status array →
  `type: { nin }` fallback.
- `sortIssuesByPriority` — priority 0 sinks below 1–4; stable tiebreak on
  `updatedAt`.
- `parseProjectIssuesResponse` — assignee present / null; GraphQL error passthrough.
- `parseFilterOptionsResponse` + `dedupeStatesByName` — duplicate names across
  teams collapse, position ordering, colour/type from first occurrence.
- `parseIssueSetAssigneeResponse` — success / `success: false` / GraphQL error.

**Backend (`__tests__` server-level):** handler query-param parsing for
`/api/linear/issues` (statuses split, `me` resolution), `assignToViewer` best-effort
(mock `assignIssueToViewer` rejecting → creation still succeeds).

**Frontend:**
- `lib/linear-filter.test.ts` — `makeDefaultFilter`, `resolveDefaultProjectId`
  (match / no match / null options), persist + restore round-trip, `filterToQuery`.
- `LinearPanel.test.ts` — pills render current filter; selecting a project /
  toggling a status / picking an assignee fires `onfilterchange` with the right
  next state; `✕` clears the right dimension; assignee chip renders initials vs
  avatar; empty-state copy.

**CLI (`linear-commands.test.ts`):**
- `parseLinearArgs` — `issues` with repeated `--status`, single-value flags,
  unknown flag error, `--json`.
- Name→id resolution (project + assignee), ambiguous/no match → usage error.
- Default injection when no flags (`--status Todo`, project from env).
- Table vs `--json` formatting.

## Docs

`README.md` Linear section:
- `LINEAR_PROJECT_URL` now also selects the default project in the sidebar filter.
- Document `webmux linear issues` and `webmux add --from-linear <id> --assign-me`.

## Rollout / migration

No persisted server state changes. Existing `.webmux.yaml` `integrations.linear`
config is untouched. The in-process issue cache shape changes but it is
memory-only. `localStorage` filter state is additive and self-healing (absent →
default).

## Follow-up (separate spec): the composer

Multi-select of issues in the panel, a `composer` skill/agent that splits work
across the selected issues, creates one webmux worktree per unit (independent
issues → parallel PRs off main; dependent → stacked PRs / stacked worktrees),
optionally spanning multiple Linear projects, and manages the stack. Not started
until this spec ships.
