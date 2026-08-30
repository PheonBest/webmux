# webmux Project Config Editor + Setup Terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit a project's `.webmux.yaml` from the dashboard (raw YAML, strictly validated, with a session-restart prompt) and add a project by running a configurable interactive setup command in an in-page terminal.

**Architecture:** A new pure `config-validate.ts` module is the single source of "what is a valid config", shared by the lenient loader, three new HTTP routes, and a `webmux config` CLI group. `runtime.ts` gains in-place config reload so a saved `.webmux.yaml` takes effect without a restart. A new `runSetupSession` in the terminal adapter owns a `wm-setup-*` tmux session running an arbitrary command; a hub route streams it over WebSocket and, on exit, diffs the projects registry to detect the newly-registered project.

**Tech Stack:** Bun + `Bun.serve` routes, `ts-rest` + zod contract (`packages/api-contract`), the `yaml` package (`parseDocument` for positions), tmux via `BunTmuxGateway`, Svelte 5 runes + `@xterm/xterm`, `bun test` (backend), `vitest` + `@testing-library/svelte` (frontend), `@clack/prompts` (CLI).

**Spec:** `docs/superpowers/specs/2026-08-30-webmux-project-config-and-setup-terminal-design.md`

## Global Constraints

- Bun-first: `Bun.file`/`Bun.write`/`Bun.spawn`/`Bun.env`, not Node equivalents, except where an existing sibling module deliberately uses sync `node:fs` (`projects-registry.ts`, `instance-registry.ts`) — match that choice for `global-config.ts`.
- TypeScript `strict: true`. No `any`, no `as` casts except narrowing a validated JSON/YAML boundary, no `@ts-ignore` / `@ts-expect-error`. Explicit return types on every function signature. Prefer `satisfies`. Discriminated unions for WS message types.
- One module = one concern; keep `backend/src/` flat. Pure logic separated from I/O and unit-tested with typed stubs.
- Prefer `Result`-style returns (`{ ok: true, ... } | { ok: false, ... }`) over throwing for expected failures.
- Parity: every user-facing capability works from the frontend **and** the CLI. Update parsing, help text, and runtime handler for the CLI.
- Do not add comments/docstrings/type annotations to code you did not change. Only implement what is in the spec.
- `PaneSplit` is exactly `"right" | "bottom"`. `PaneKind` is exactly `"agent" | "shell" | "command"`. `AgentKind` is exactly `"claude" | "codex" | "opencode"`. `RuntimeKind` is exactly `"host" | "docker"`. Copied verbatim from `backend/src/domain/config.ts`.
- Shared config file written by this feature is `.webmux.yaml` (the shared file), never `.webmux.local.yaml`.
- Default `projectInitCommand` is the string `"webmux init"`.
- New tmux session prefix for setup sessions is `wm-setup-<port>-`.

---

## File Structure

**Backend — create:**
- `backend/src/domain/config-validate.ts` — pure predicates + `validateProjectConfigYaml`.
- `backend/src/adapters/global-config.ts` — typed reader/writer for `~/.webmux/config.json`; `resolveProjectInitCommand`.
- `backend/src/__tests__/config-validate.test.ts`
- `backend/src/__tests__/global-config.test.ts`
- `backend/src/__tests__/setup-terminal.test.ts`
- `backend/src/__tests__/project-config-routes.test.ts`

**Backend — modify:**
- `backend/src/adapters/config.ts` — import shared predicates; add `readRawProjectConfig`, `persistProjectConfig`.
- `backend/src/runtime.ts` — mutable config holder + `reloadConfig()`.
- `backend/src/services/lifecycle-service.ts` — add `reopenWorktree(branch)`.
- `backend/src/adapters/terminal.ts` — add `runSetupSession`; add `wm-setup-` to `cleanupStaleSessions`.
- `backend/src/server.ts` — 3 per-project config routes + 1 hub setup-terminal route + `/ws/setup/:setupId` handler; `getFrontendConfig` gains `projectInitCommand`; `config` becomes a live reference through `runtime.config`.

**Contract — modify:**
- `packages/api-contract/src/schemas.ts` — new zod schemas.
- `packages/api-contract/src/contract.ts` — new `apiPaths` + `apiContract` entries.

**Frontend — create:**
- `frontend/src/lib/ProjectConfigDialog.svelte` + `.test.ts`
- `frontend/src/lib/SetupTerminalDialog.svelte` + `.test.ts`

**Frontend — modify:**
- `frontend/src/lib/api.ts` — `fetchProjectConfigRaw`, `validateProjectConfigRaw`, `saveProjectConfigRaw`, `createSetupTerminal`, `setupTerminalSocketUrl`.
- `frontend/src/lib/types.ts` — `ConfigError`, `ProjectConfigRaw`, `SaveConfigResult`, `SetupTerminalComplete`; `AppConfig.projectInitCommand`.
- `frontend/src/lib/ProjectSwitcher.svelte` — gear button → `ProjectConfigDialog`; "Add & run setup" → `SetupTerminalDialog`.
- `frontend/src/lib/EmptyProjects.svelte` — "Add & run setup" button → `SetupTerminalDialog`.
- `frontend/src/lib/SettingsDialog.svelte` — "Edit project config →" link.
- `frontend/src/lib/Terminal.svelte` — accept `{ setupId }` as an alternative to `{ worktree }` for the WS connection.

**CLI — create:**
- `bin/src/config-commands.ts` + `bin/src/config-commands.test.ts`

**CLI — modify:**
- `bin/src/webmux.ts` — `"config"` in `RootCommand`, parse + dispatch, usage text.

**Docs — modify:**
- `README.md` — one paragraph under an existing "Create & Manage Worktrees" / config section.

---

## Part 1 — Strict config validator

### Task 1: `config-validate.ts` — field predicates + `validateProjectConfigYaml`

**Files:**
- Create: `backend/src/domain/config-validate.ts`
- Test: `backend/src/__tests__/config-validate.test.ts`

**Interfaces:**
- Consumes: types from `backend/src/domain/config.ts` (`ProjectConfig`, `PaneTemplate`, `PaneSplit`, `PaneKind`, `AgentKind`, `RuntimeKind`).
- Produces:
  - `isAgentKind(v: unknown): v is AgentKind`
  - `isPaneKind(v: unknown): v is PaneKind`
  - `isPaneSplit(v: unknown): v is PaneSplit`
  - `isRuntimeKind(v: unknown): v is RuntimeKind`
  - `interface ConfigError { path: string; message: string; line?: number }`
  - `type ValidateResult = { ok: true; config: ProjectConfig } | { ok: false; errors: ConfigError[] }`
  - `validateProjectConfigYaml(text: string): ValidateResult`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/__tests__/config-validate.test.ts
import { describe, expect, it } from "bun:test";
import { validateProjectConfigYaml } from "../domain/config-validate";

function errPaths(text: string): string[] {
  const r = validateProjectConfigYaml(text);
  if (r.ok) throw new Error("expected invalid");
  return r.errors.map((e) => e.path).sort();
}

describe("validateProjectConfigYaml", () => {
  it("accepts a minimal valid config and returns a parsed ProjectConfig", () => {
    const r = validateProjectConfigYaml(
      "name: demo\nprofiles:\n  default:\n    panes:\n      - { id: agent, kind: agent, focus: true }\n",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.name).toBe("demo");
      expect(r.config.profiles.default.panes).toEqual([{ id: "agent", kind: "agent", focus: true }]);
    }
  });

  it("reports a YAML syntax error with a line number", () => {
    const r = validateProjectConfigYaml("name: demo\n  bad: : :\n");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].line).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown top-level key (typo guard)", () => {
    expect(errPaths("profile:\n  default:\n    panes: []\n")).toContain("profile");
  });

  it("rejects an invalid pane split", () => {
    expect(errPaths(
      "profiles:\n  default:\n    panes:\n      - { kind: agent }\n      - { kind: shell, split: below }\n",
    )).toContain("profiles.default.panes[1].split");
  });

  it("rejects a command pane with no command", () => {
    expect(errPaths(
      "profiles:\n  default:\n    panes:\n      - { kind: command }\n",
    )).toContain("profiles.default.panes[0].command");
  });

  it("rejects duplicate pane ids within a profile", () => {
    expect(errPaths(
      "profiles:\n  default:\n    panes:\n      - { id: a, kind: agent }\n      - { id: a, kind: shell }\n",
    )).toContain("profiles.default.panes[1].id");
  });

  it("rejects more than one focused pane", () => {
    expect(errPaths(
      "profiles:\n  default:\n    panes:\n      - { kind: agent, focus: true }\n      - { kind: shell, focus: true }\n",
    )).toContain("profiles.default.panes[1].focus");
  });

  it("rejects sizePct outside 1..99", () => {
    expect(errPaths(
      "profiles:\n  default:\n    panes:\n      - { kind: agent }\n      - { kind: shell, split: right, sizePct: 0 }\n",
    )).toContain("profiles.default.panes[1].sizePct");
  });

  it("rejects an empty panes array", () => {
    expect(errPaths("profiles:\n  default:\n    panes: []\n")).toContain("profiles.default.panes");
  });

  it("rejects a docker profile with no image", () => {
    expect(errPaths(
      "profiles:\n  sandbox:\n    runtime: docker\n    panes:\n      - { kind: agent }\n",
    )).toContain("profiles.sandbox.image");
  });

  it("rejects a bad defaultAgent", () => {
    expect(errPaths(
      "workspace:\n  defaultAgent: gpt\nprofiles:\n  default:\n    panes:\n      - { kind: agent }\n",
    )).toContain("workspace.defaultAgent");
  });

  it("collects multiple errors in one pass", () => {
    const r = validateProjectConfigYaml(
      "workspace:\n  defaultAgent: nope\nprofiles:\n  default:\n    panes:\n      - { kind: bogus }\n",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && bun test src/__tests__/config-validate.test.ts`
Expected: FAIL — `Cannot find module '../domain/config-validate'`.

- [ ] **Step 3: Implement `config-validate.ts`**

Guidance (write the full module — this is the shape, fill in every branch listed):

```ts
import { parseDocument } from "yaml";
import type {
  AgentKind,
  PaneKind,
  PaneSplit,
  ProjectConfig,
  RuntimeKind,
} from "./config";

export interface ConfigError {
  path: string;
  message: string;
  line?: number;
}

export type ValidateResult =
  | { ok: true; config: ProjectConfig }
  | { ok: false; errors: ConfigError[] };

export function isAgentKind(v: unknown): v is AgentKind {
  return v === "claude" || v === "codex" || v === "opencode";
}
export function isPaneKind(v: unknown): v is PaneKind {
  return v === "agent" || v === "shell" || v === "command";
}
export function isPaneSplit(v: unknown): v is PaneSplit {
  return v === "right" || v === "bottom";
}
export function isRuntimeKind(v: unknown): v is RuntimeKind {
  return v === "host" || v === "docker";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TOP_LEVEL_KEYS = new Set([
  "name", "workspace", "profiles", "agents", "services", "startupEnvs",
  "integrations", "lifecycleHooks", "auto_name", "oneshot", "alerts",
]);

const PANE_KEYS = new Set(["id", "kind", "split", "sizePct", "focus", "command", "cwd", "workingDir"]);
const PROFILE_KEYS = new Set(["runtime", "systemPrompt", "envPassthrough", "yolo", "panes", "image", "mounts"]);

export function validateProjectConfigYaml(text: string): ValidateResult {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({
        path: "",
        message: e.message,
        // yaml's YAMLParseError carries linePos: [{ line, col }, ...]
        line: e.linePos?.[0]?.line,
      })),
    };
  }

  const root: unknown = doc.toJSON();
  const errors: ConfigError[] = [];
  const err = (path: string, message: string): void => { errors.push({ path, message }); };

  if (root === null || root === undefined) {
    // empty file is allowed — behaves as "all defaults"
    return finish(errors, "");
  }
  if (!isRecord(root)) {
    err("", "config root must be a mapping");
    return { ok: false, errors };
  }

  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key)) err(key, `unknown top-level key "${key}"`);
  }

  if ("name" in root && typeof root.name !== "string") err("name", "name must be a string");

  if (isRecord(root.workspace)) {
    const ws = root.workspace;
    if ("mainBranch" in ws && typeof ws.mainBranch !== "string") err("workspace.mainBranch", "must be a string");
    if ("worktreeRoot" in ws && typeof ws.worktreeRoot !== "string") err("workspace.worktreeRoot", "must be a string");
    if ("defaultAgent" in ws && !isAgentKind(ws.defaultAgent)) err("workspace.defaultAgent", 'must be one of "claude", "codex", "opencode"');
    if (isRecord(ws.autoPull)) {
      const ap = ws.autoPull;
      if ("enabled" in ap && typeof ap.enabled !== "boolean") err("workspace.autoPull.enabled", "must be a boolean");
      if ("intervalSeconds" in ap && (typeof ap.intervalSeconds !== "number" || ap.intervalSeconds < 30)) {
        err("workspace.autoPull.intervalSeconds", "must be a number >= 30");
      }
    } else if ("autoPull" in ws) {
      err("workspace.autoPull", "must be a mapping");
    }
  } else if ("workspace" in root) {
    err("workspace", "must be a mapping");
  }

  if (isRecord(root.profiles)) {
    for (const [name, raw] of Object.entries(root.profiles)) {
      validateProfile(`profiles.${name}`, raw, err);
    }
  } else if ("profiles" in root) {
    err("profiles", "must be a mapping of profile name -> profile");
  }

  if ("services" in root) validateServices(root.services, err);
  if ("startupEnvs" in root) validateStartupEnvs(root.startupEnvs, err);
  if ("lifecycleHooks" in root) validateLifecycleHooks(root.lifecycleHooks, err);
  // integrations / alerts / oneshot / auto_name: shape checks mirroring adapters/config.ts parsers.
  // (Implement the same key/type rules the parse* helpers apply, reporting instead of dropping.)

  return finish(errors, "");
}

function validateProfile(base: string, raw: unknown, err: (p: string, m: string) => void): void {
  if (!isRecord(raw)) { err(base, "must be a mapping"); return; }
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.has(key)) err(`${base}.${key}`, `unknown profile key "${key}"`);
  }
  if ("runtime" in raw && !isRuntimeKind(raw.runtime)) err(`${base}.runtime`, 'must be "host" or "docker"');
  if ("envPassthrough" in raw && !(Array.isArray(raw.envPassthrough) && raw.envPassthrough.every((x) => typeof x === "string"))) {
    err(`${base}.envPassthrough`, "must be an array of strings");
  }
  if ("yolo" in raw && typeof raw.yolo !== "boolean") err(`${base}.yolo`, "must be a boolean");
  if ("systemPrompt" in raw && typeof raw.systemPrompt !== "string") err(`${base}.systemPrompt`, "must be a string");
  if (raw.runtime === "docker" && (typeof raw.image !== "string" || raw.image.trim() === "")) {
    err(`${base}.image`, "a docker profile requires a non-empty image");
  }
  if ("image" in raw && raw.image !== undefined && typeof raw.image !== "string") err(`${base}.image`, "must be a string");

  if (!Array.isArray(raw.panes)) {
    err(`${base}.panes`, "must be a non-empty array");
    return;
  }
  if (raw.panes.length === 0) err(`${base}.panes`, "must contain at least one pane");

  const seenIds = new Set<string>();
  let focusCount = 0;
  raw.panes.forEach((pane, i) => {
    const p = `${base}.panes[${i}]`;
    if (!isRecord(pane)) { err(p, "must be a mapping"); return; }
    for (const key of Object.keys(pane)) {
      if (!PANE_KEYS.has(key)) err(`${p}.${key}`, `unknown pane key "${key}"`);
    }
    if (!isPaneKind(pane.kind)) err(`${p}.kind`, 'must be one of "agent", "shell", "command"');
    if ("id" in pane) {
      if (typeof pane.id !== "string" || pane.id.trim() === "") {
        err(`${p}.id`, "must be a non-empty string");
      } else if (seenIds.has(pane.id)) {
        err(`${p}.id`, `duplicate pane id "${pane.id}"`);
      } else {
        seenIds.add(pane.id);
      }
    }
    if ("split" in pane && !isPaneSplit(pane.split)) err(`${p}.split`, 'must be "right" or "bottom"');
    if ("sizePct" in pane && (typeof pane.sizePct !== "number" || pane.sizePct < 1 || pane.sizePct > 99)) {
      err(`${p}.sizePct`, "must be a number between 1 and 99");
    }
    if ("cwd" in pane && pane.cwd !== "worktree" && pane.cwd !== "repo") err(`${p}.cwd`, 'must be "worktree" or "repo"');
    if ("focus" in pane) {
      if (typeof pane.focus !== "boolean") err(`${p}.focus`, "must be a boolean");
      else if (pane.focus) focusCount += 1;
    }
    if (pane.kind === "command") {
      if (typeof pane.command !== "string" || pane.command.trim() === "") err(`${p}.command`, "a command pane requires a non-empty command");
    } else if ("command" in pane) {
      err(`${p}.command`, `command is only valid on a "command" pane`);
    }
    if ("workingDir" in pane && typeof pane.workingDir !== "string") err(`${p}.workingDir`, "must be a string");
  });
  if (focusCount > 1) {
    // attribute the error to the last focused pane
    const lastFocused = raw.panes.map((x, i) => [x, i] as const).filter(([x]) => isRecord(x) && x.focus === true).at(-1);
    if (lastFocused) err(`${base}.panes[${lastFocused[1]}].focus`, "at most one pane may have focus: true");
  }
}

function validateServices(raw: unknown, err: (p: string, m: string) => void): void {
  if (!Array.isArray(raw)) { err("services", "must be an array"); return; }
  raw.forEach((s, i) => {
    if (!isRecord(s)) { err(`services[${i}]`, "must be a mapping"); return; }
    if (typeof s.name !== "string" || s.name === "") err(`services[${i}].name`, "must be a non-empty string");
    if (typeof s.portEnv !== "string" || s.portEnv === "") err(`services[${i}].portEnv`, "must be a non-empty string");
    if ("portStart" in s && typeof s.portStart !== "number") err(`services[${i}].portStart`, "must be a number");
    if ("portStep" in s && typeof s.portStep !== "number") err(`services[${i}].portStep`, "must be a number");
    if ("urlTemplate" in s && typeof s.urlTemplate !== "string") err(`services[${i}].urlTemplate`, "must be a string");
  });
}

function validateStartupEnvs(raw: unknown, err: (p: string, m: string) => void): void {
  if (!isRecord(raw)) { err("startupEnvs", "must be a mapping"); return; }
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" && typeof v !== "boolean" && typeof v !== "number") {
      err(`startupEnvs.${k}`, "must be a string, number, or boolean");
    }
  }
}

function validateLifecycleHooks(raw: unknown, err: (p: string, m: string) => void): void {
  if (!isRecord(raw)) { err("lifecycleHooks", "must be a mapping"); return; }
  if ("postCreate" in raw && typeof raw.postCreate !== "string") err("lifecycleHooks.postCreate", "must be a string");
  if ("preRemove" in raw && typeof raw.preRemove !== "string") err("lifecycleHooks.preRemove", "must be a string");
}

function finish(errors: ConfigError[], _root: string): ValidateResult {
  if (errors.length > 0) return { ok: false, errors };
  // lazy import avoids a cycle: adapters/config.ts imports predicates from here
  const { parseProjectConfigChecked } = require("../adapters/config") as typeof import("../adapters/config");
  return { ok: true, config: parseProjectConfigChecked() ?? emptyFallback() };
}
```

Note for the implementer: `finish` needs the parsed `ProjectConfig`. The cleanest wiring is: in Task 2, export a small `parseProjectConfigFromParsed(parsed: Record<string, unknown>): ProjectConfig` from `adapters/config.ts` (it already has private `parseProjectConfig`), and call **that** here with `doc.toJSON()` — no `require`, a normal top import, because `adapters/config.ts` will import only the `is*` predicates from this file and that is not a cycle at module-eval time if predicates are declared before the import site. If the bundler complains about a cycle, invert: keep `validateProjectConfigYaml` returning `{ ok: true, parsed }` and let callers run `parseProjectConfigFromParsed`. Pick whichever keeps both `bun test` suites green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && bun test src/__tests__/config-validate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/config-validate.ts backend/src/__tests__/config-validate.test.ts
git commit -m "feat(config): strict .webmux.yaml validator"
```

### Task 2: Share predicates with the lenient loader

**Files:**
- Modify: `backend/src/adapters/config.ts`
- Test: `backend/src/__tests__/config.test.ts` (existing — must still pass unchanged)

**Interfaces:**
- Consumes: `isAgentKind`, `isPaneKind`, `isPaneSplit`, `isRuntimeKind` from `../domain/config-validate`.
- Produces: `export function parseProjectConfigFromParsed(parsed: Record<string, unknown>): ProjectConfig` (wraps the existing private `parseProjectConfig`).

- [ ] **Step 1: Add a characterization test for the shared behavior**

```ts
// append to backend/src/__tests__/config.test.ts
import { parseProjectConfigFromParsed } from "../adapters/config";

it("parseProjectConfigFromParsed drops an invalid split like the loader does", () => {
  const cfg = parseProjectConfigFromParsed({
    profiles: { default: { panes: [{ kind: "agent" }, { kind: "shell", split: "below" }] } },
  });
  expect(cfg.profiles.default.panes.find((p) => p.id !== "agent")?.split).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test src/__tests__/config.test.ts`
Expected: FAIL — `parseProjectConfigFromParsed` is not exported.

- [ ] **Step 3: Refactor**

In `backend/src/adapters/config.ts`:
- Replace the local `parseAgentKind` truthiness with usage of `isAgentKind` (keep `parseAgentKind` returning the fallback `"claude"`, but implement it as `return isAgentKind(value) ? value : "claude";`).
- In `parsePane`, replace the inline `raw.kind !== "agent" && ...` guard with `if (!isPaneKind(raw.kind)) return null;` and `if (raw.split && isPaneSplit(raw.split)) pane.split = raw.split;` etc. Behavior must not change — invalid values still get dropped.
- Add:

```ts
export function parseProjectConfigFromParsed(parsed: Record<string, unknown>): ProjectConfig {
  return parseProjectConfig(parsed);
}
```

- Add the import at the top: `import { isAgentKind, isPaneKind, isPaneSplit, isRuntimeKind } from "../domain/config-validate";` — but if this creates an import cycle with Task 1's `finish()`, apply the inversion noted in Task 1 Step 3.

- [ ] **Step 4: Run the full config + validator suites**

Run: `cd backend && bun test src/__tests__/config.test.ts src/__tests__/config-validate.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/config.ts backend/src/__tests__/config.test.ts
git commit -m "refactor(config): share field predicates between loader and validator"
```

---

## Part 2 — Config hot-reload

### Task 3: In-place config reload in `runtime.ts`

**Files:**
- Modify: `backend/src/runtime.ts:44` (the `config: ProjectConfig` field) and `:65` (`const config = loadConfig(...)`)
- Modify: `backend/src/server.ts:231` (`const config: ProjectConfig = runtime.config;`)
- Test: `backend/src/__tests__/runtime-reload-config.test.ts` (create)

**Interfaces:**
- Produces on the `WebmuxRuntime` object: `reloadConfig(): ProjectConfig`. It re-runs `loadConfig(projectDir, { resolvedRoot: true })` and copies the result **onto the same `config` object reference** (delete removed own keys, `Object.assign` the rest) so every service holding that reference sees the update. Returns the same reference.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/__tests__/runtime-reload-config.test.ts
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebmuxRuntime } from "../runtime";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "wm-reload-"));
  dirs.push(d);
  Bun.spawnSync(["git", "init", "-q", d]);
  writeFileSync(join(d, ".webmux.yaml"), "name: before\n");
  return d;
}

it("reloadConfig picks up an edited .webmux.yaml on the same reference", () => {
  const dir = repo();
  const rt = createWebmuxRuntime({ projectDir: dir });
  const ref = rt.config;
  expect(rt.config.name).toBe("before");
  writeFileSync(join(dir, ".webmux.yaml"), "name: after\n");
  rt.reloadConfig();
  expect(rt.config).toBe(ref); // same object identity
  expect(rt.config.name).toBe("after");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test src/__tests__/runtime-reload-config.test.ts`
Expected: FAIL — `rt.reloadConfig is not a function`.

- [ ] **Step 3: Implement**

In `backend/src/runtime.ts`:

```ts
// after: const config = loadConfig(projectDir, { resolvedRoot: true });
function reloadConfig(): ProjectConfig {
  const next = loadConfig(projectDir, { resolvedRoot: true });
  for (const key of Object.keys(config)) {
    if (!(key in next)) delete (config as Record<string, unknown>)[key];
  }
  Object.assign(config, next);
  return config;
}
```

Add `reloadConfig` to the `WebmuxRuntime` interface (`reloadConfig(): ProjectConfig;`) and to the returned object.

In `backend/src/server.ts` keep `const config = runtime.config;` — it is already the live reference; add nothing there yet (Task 7 calls `runtime.reloadConfig()`).

- [ ] **Step 4: Verify**

Run: `cd backend && bun test src/__tests__/runtime-reload-config.test.ts src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Grep for destructuring that would defeat the live reference**

Run: `cd backend && grep -rn "const { *config" src/ ; grep -rn "config\.profiles\b\|config\.workspace\b" src/services/reconciliation-service.ts src/services/lifecycle-service.ts | head`
Expected: services read `this.deps.config.X` / `deps.config.X` at call time (not copied in the constructor). If any service copies `config.profiles` into a constructor field, note it in the commit body and add a follow-up fix task — do **not** silently leave it.

- [ ] **Step 6: Commit**

```bash
git add backend/src/runtime.ts backend/src/__tests__/runtime-reload-config.test.ts
git commit -m "feat(runtime): reloadConfig() re-reads .webmux.yaml onto the live reference"
```

---

## Part 3 — Raw config read/write adapter

### Task 4: `readRawProjectConfig` + `persistProjectConfig`

**Files:**
- Modify: `backend/src/adapters/config.ts`
- Test: `backend/src/__tests__/config.test.ts` (append)

**Interfaces:**
- Produces:
  - `readRawProjectConfig(dir: string): { text: string; path: string; exists: boolean }` — reads `<root>/.webmux.yaml`; when absent, `text` is `""` and `exists` is `false`, `path` still points at where it would be written.
  - `persistProjectConfig(dir: string, text: string): Promise<void>` — `Bun.write(<root>/.webmux.yaml, text)`. No validation here (callers validate).

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/__tests__/config.test.ts
import { readRawProjectConfig, persistProjectConfig } from "../adapters/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("readRawProjectConfig reports absence, persistProjectConfig writes .webmux.yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-raw-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  try {
    const before = readRawProjectConfig(dir);
    expect(before.exists).toBe(false);
    expect(before.text).toBe("");
    expect(before.path.endsWith(".webmux.yaml")).toBe(true);

    await persistProjectConfig(dir, "name: written\n");
    const after = readRawProjectConfig(dir);
    expect(after.exists).toBe(true);
    expect(after.text).toBe("name: written\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test src/__tests__/config.test.ts -t "readRawProjectConfig"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
export function readRawProjectConfig(dir: string): { text: string; path: string; exists: boolean } {
  const root = projectRoot(dir);
  const path = join(root, ".webmux.yaml");
  try {
    return { text: readFileSync(path, "utf8"), path, exists: true };
  } catch {
    return { text: "", path, exists: false };
  }
}

export async function persistProjectConfig(dir: string, text: string): Promise<void> {
  const root = projectRoot(dir);
  await Bun.write(join(root, ".webmux.yaml"), text);
}
```

- [ ] **Step 4: Verify**

Run: `cd backend && bun test src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/config.ts backend/src/__tests__/config.test.ts
git commit -m "feat(config): readRawProjectConfig + persistProjectConfig for the shared file"
```

---

## Part 4 — Lifecycle: reopen a worktree to re-apply panes

### Task 5: `LifecycleService.reopenWorktree`

**Files:**
- Modify: `backend/src/services/lifecycle-service.ts`
- Test: `backend/src/__tests__/lifecycle-service.test.ts` (append, follow existing stub setup in that file)

**Interfaces:**
- Consumes: existing private `this.resolveExistingWorktree`, `isWorktreeOpen(this.deps.tmux, this.deps.projectRoot, branch)`, `this.openWorktree(branch)`, `this.deps.reconciliation.reconcile`.
- Produces: `reopenWorktree(branch: string): Promise<{ restarted: boolean }>` — if the worktree's session is currently open, calls `this.openWorktree(branch)` (which tears down and recreates the tmux window from the **current** profile panes) and returns `{ restarted: true }`; otherwise returns `{ restarted: false }` without touching anything.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/__tests__/lifecycle-service.test.ts, reusing that file's makeService()/stub helpers
it("reopenWorktree restarts an open worktree and no-ops a closed one", async () => {
  const { service, tmux } = makeServiceWithOpenWorktree("feat-x"); // build on existing helpers
  const opened = await service.reopenWorktree("feat-x");
  expect(opened.restarted).toBe(true);

  const { service: svc2 } = makeServiceWithClosedWorktree("feat-y");
  const closed = await svc2.reopenWorktree("feat-y");
  expect(closed.restarted).toBe(false);
});
```

(If the existing test file lacks `makeServiceWithOpenWorktree`-style helpers, add minimal ones next to the current stubs — mirror how `setWorktreeProfile` is tested there.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test src/__tests__/lifecycle-service.test.ts -t "reopenWorktree"`
Expected: FAIL — `service.reopenWorktree is not a function`.

- [ ] **Step 3: Implement**

```ts
async reopenWorktree(branch: string): Promise<{ restarted: boolean }> {
  try {
    const resolved = await this.resolveExistingWorktree(branch);
    if (!resolved.meta) {
      throw new LifecycleError(`Worktree ${branch} has no managed metadata`, 409);
    }
    if (!isWorktreeOpen(this.deps.tmux, this.deps.projectRoot, branch)) {
      return { restarted: false };
    }
    await this.openWorktree(branch);
    return { restarted: true };
  } catch (error) {
    throw this.wrapOperationError(error);
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd backend && bun test src/__tests__/lifecycle-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/lifecycle-service.ts backend/src/__tests__/lifecycle-service.test.ts
git commit -m "feat(lifecycle): reopenWorktree to re-apply a changed pane layout"
```

---

## Part 5 — Contract + backend routes for the config editor

### Task 6: Contract schemas + paths

**Files:**
- Modify: `packages/api-contract/src/schemas.ts`
- Modify: `packages/api-contract/src/contract.ts`
- Test: `packages/api-contract` — follow `client.test.ts` if it asserts path shape; otherwise no test, the type-check is the gate.

**Interfaces:**
- Produces (zod schemas + inferred types exported from `index.ts` transitively):

```ts
// schemas.ts
export const ConfigErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
  line: z.number().int().positive().optional(),
});
export const ProjectConfigRawResponseSchema = z.object({
  text: z.string(),
  path: z.string(),
  exists: z.boolean(),
});
export const ProjectConfigRawRequestSchema = z.object({ text: z.string() });
export const ValidateConfigResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), errors: z.array(ConfigErrorSchema) }),
]);
export const SaveConfigResultSchema = z.object({
  affected: z.array(z.object({ profile: z.string(), branches: z.array(z.string()) })),
});
export type ConfigError = z.infer<typeof ConfigErrorSchema>;
export type ProjectConfigRawResponse = z.infer<typeof ProjectConfigRawResponseSchema>;
export type SaveConfigResult = z.infer<typeof SaveConfigResultSchema>;
```

- Add to `apiPaths` (in `contract.ts`):
```ts
fetchProjectConfigRaw: "/api/project/config/raw",
validateProjectConfigRaw: "/api/project/config/validate",
saveProjectConfigRaw: "/api/project/config/raw",
```
- Add to `apiContract`:
```ts
fetchProjectConfigRaw: {
  method: "GET", path: apiPaths.fetchProjectConfigRaw,
  responses: { 200: ProjectConfigRawResponseSchema, 500: ErrorResponseSchema },
},
validateProjectConfigRaw: {
  method: "POST", path: apiPaths.validateProjectConfigRaw,
  body: ProjectConfigRawRequestSchema,
  responses: { 200: ValidateConfigResponseSchema, 500: ErrorResponseSchema },
},
saveProjectConfigRaw: {
  method: "PUT", path: apiPaths.saveProjectConfigRaw,
  body: ProjectConfigRawRequestSchema,
  responses: {
    200: SaveConfigResultSchema,
    422: z.object({ errors: z.array(ConfigErrorSchema) }),
    500: ErrorResponseSchema,
  },
},
```
Also extend `AppConfigSchema` (schemas.ts:617) with `projectInitCommand: z.string()`.

- [ ] **Step 1: Add the schemas and contract entries** (code above).
- [ ] **Step 2: Typecheck the package**

Run: `cd packages/api-contract && bun run build || bunx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Typecheck backend + frontend against the new contract**

Run: `cd backend && bunx tsc --noEmit` and `cd frontend && bunx tsc --noEmit`
Expected: backend fails only where it must now supply `projectInitCommand` in `getFrontendConfig` (fixed in Task 7); frontend fails only on `AppConfig` usages if any exhaustively construct it (unlikely). Note failures for the next tasks.

- [ ] **Step 4: Commit**

```bash
git add packages/api-contract/src/schemas.ts packages/api-contract/src/contract.ts
git commit -m "feat(contract): project config raw get/validate/save endpoints"
```

### Task 7: Backend route handlers for the config editor

**Files:**
- Modify: `backend/src/server.ts` — add `apiGetProjectConfigRaw`, `apiValidateProjectConfigRaw`, `apiSaveProjectConfigRaw`; register the 3 routes next to `[apiPaths.fetchConfig]` (server.ts ~line 2170); update `getFrontendConfig` to include `projectInitCommand`.
- Test: `backend/src/__tests__/project-config-routes.test.ts` (create)

**Interfaces:**
- Consumes: `validateProjectConfigYaml` (Task 1), `readRawProjectConfig` / `persistProjectConfig` (Task 4), `runtime.reloadConfig` (Task 3), `lifecycleService.reopenWorktree` (Task 5), `projectRuntime` (list running worktrees + their profile), `PROJECT_DIR`, `parseJsonBody`, `jsonResponse`, `errorResponse`, `resolveProjectInitCommand` (Task 13).
- Produces: the three route handlers and the impact computation `computeAffectedProfiles(prev: ProjectConfig, next: ProjectConfig): { profile: string; branches: string[] }[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/__tests__/project-config-routes.test.ts
import { describe, expect, it } from "bun:test";
import { computeAffectedProfiles } from "../server-config-impact"; // extract pure fn (see Step 3)
import type { ProjectConfig } from "../domain/config";

function cfg(panesByProfile: Record<string, unknown[]>): ProjectConfig {
  // build a minimal ProjectConfig via parseProjectConfigFromParsed
  const { parseProjectConfigFromParsed } = require("../adapters/config");
  return parseProjectConfigFromParsed({
    profiles: Object.fromEntries(Object.entries(panesByProfile).map(([k, panes]) => [k, { panes }])),
  });
}

describe("computeAffectedProfiles", () => {
  it("flags a profile whose panes changed", () => {
    const prev = cfg({ default: [{ kind: "agent" }, { kind: "shell", split: "right" }] });
    const next = cfg({ default: [{ kind: "agent" }] });
    const running = [{ branch: "feat-a", profile: "default" }, { branch: "feat-b", profile: "other" }];
    const affected = computeAffectedProfiles(prev, next, running);
    expect(affected).toEqual([{ profile: "default", branches: ["feat-a"] }]);
  });

  it("returns nothing when panes are unchanged", () => {
    const prev = cfg({ default: [{ kind: "agent" }] });
    const next = cfg({ default: [{ kind: "agent" }] });
    expect(computeAffectedProfiles(prev, next, [{ branch: "x", profile: "default" }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test src/__tests__/project-config-routes.test.ts`
Expected: FAIL — module `../server-config-impact` missing.

- [ ] **Step 3: Implement the pure impact fn + the handlers**

Create `backend/src/server-config-impact.ts`:

```ts
import type { ProjectConfig } from "./domain/config";

export interface RunningWorktreeProfile { branch: string; profile: string | null }

export function computeAffectedProfiles(
  prev: ProjectConfig,
  next: ProjectConfig,
  running: RunningWorktreeProfile[],
): { profile: string; branches: string[] }[] {
  const changed = new Set<string>();
  const names = new Set([...Object.keys(prev.profiles), ...Object.keys(next.profiles)]);
  for (const name of names) {
    const a = JSON.stringify(prev.profiles[name]?.panes ?? null);
    const b = JSON.stringify(next.profiles[name]?.panes ?? null);
    if (a !== b) changed.add(name);
  }
  const out: { profile: string; branches: string[] }[] = [];
  for (const name of changed) {
    const branches = running.filter((r) => r.profile === name).map((r) => r.branch);
    if (branches.length > 0) out.push({ profile: name, branches });
  }
  return out;
}
```

In `server.ts`:

```ts
async function apiGetProjectConfigRaw(): Promise<Response> {
  return jsonResponse(readRawProjectConfig(PROJECT_DIR));
}

async function apiValidateProjectConfigRaw(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, ProjectConfigRawRequestSchema);
  if (!parsed.ok) return parsed.response;
  const result = validateProjectConfigYaml(parsed.data.text);
  return jsonResponse(result.ok ? { ok: true } : { ok: false, errors: result.errors });
}

async function apiSaveProjectConfigRaw(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, ProjectConfigRawRequestSchema);
  if (!parsed.ok) return parsed.response;
  const result = validateProjectConfigYaml(parsed.data.text);
  if (!result.ok) return jsonResponse({ errors: result.errors }, 422);

  const prev = structuredClone(config); // capture before reload; `config` is the live runtime reference
  await persistProjectConfig(PROJECT_DIR, parsed.data.text);
  runtime.reloadConfig();

  const running = projectRuntime.listManagedWorktrees().map((w) => ({ branch: w.branch, profile: w.profile }));
  const affected = computeAffectedProfiles(prev, config, running);
  return jsonResponse({ affected });
}
```

Register (near `[apiPaths.fetchConfig]`):

```ts
[apiPaths.fetchProjectConfigRaw]: {
  GET: () => catching("GET /api/project/config/raw", () => apiGetProjectConfigRaw()),
  PUT: (req) => catching("PUT /api/project/config/raw", () => apiSaveProjectConfigRaw(req)),
},
[apiPaths.validateProjectConfigRaw]: {
  POST: (req) => catching("POST /api/project/config/validate", () => apiValidateProjectConfigRaw(req)),
},
```

(Confirm the exact name of `projectRuntime`'s "list managed worktrees" method — grep `projectRuntime.list` in server.ts and reuse whatever the PR/reconcile code already calls; adjust the `.map` accessor for `profile`.)

In `getFrontendConfig`, add `projectInitCommand: resolveProjectInitCommand()` to the returned object.

- [ ] **Step 4: Run tests**

Run: `cd backend && bun test src/__tests__/project-config-routes.test.ts && bunx tsc --noEmit`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server-config-impact.ts backend/src/__tests__/project-config-routes.test.ts
git commit -m "feat(server): project config raw get/validate/save routes"
```

---

## Part 6 — Frontend config dialog

### Task 8: `api.ts` client functions

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/types.ts`
- Test: `frontend/src/lib/api.test.ts` (append, mirror existing tests there)

**Interfaces:**
- Produces:
  - `fetchProjectConfigRaw(): Promise<ProjectConfigRaw>` where `ProjectConfigRaw = { text: string; path: string; exists: boolean }`
  - `validateProjectConfigRaw(text: string): Promise<{ ok: true } | { ok: false; errors: ConfigError[] }>`
  - `saveProjectConfigRaw(text: string): Promise<{ ok: true; affected: AffectedProfile[] } | { ok: false; errors: ConfigError[] }>` — maps a `422` body to `{ ok: false, errors }`.
  - types in `types.ts`: `ConfigError`, `ProjectConfigRaw`, `AffectedProfile = { profile: string; branches: string[] }`.

- [ ] **Step 1: Write failing tests** mirroring how `api.test.ts` stubs `fetch`/the ts-rest client for an existing per-project call (find one, e.g. `setFallbackNotificationDelay`, copy its test).
- [ ] **Step 2: Run** `cd frontend && bunx vitest run src/lib/api.test.ts` → FAIL.
- [ ] **Step 3: Implement** using the existing `projectApi` client wrapper (see `api.ts:54` "Per-project client"). For `saveProjectConfigRaw`, branch on the response status: ts-rest returns `{ status, body }` — `status === 422` → `{ ok: false, errors: body.errors }`; `200` → `{ ok: true, affected: body.affected }`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(frontend): api client for project config raw endpoints"`

### Task 9: `ProjectConfigDialog.svelte`

**Files:**
- Create: `frontend/src/lib/ProjectConfigDialog.svelte`
- Create: `frontend/src/lib/ProjectConfigDialog.test.ts`

**Interfaces:**
- Consumes: `fetchProjectConfigRaw`, `validateProjectConfigRaw`, `saveProjectConfigRaw` (Task 8); `BaseDialog.svelte`; `Btn.svelte`.
- Produces: component with props `{ isOpen: boolean; onclose: () => void; onrestart: (branches: string[]) => void }`. `onrestart` is called with the flattened set of branches the user agreed to restart (parent already owns per-worktree restart via the profile-reapply flow).

- [ ] **Step 1: Write failing tests**

```ts
// frontend/src/lib/ProjectConfigDialog.test.ts
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectConfigDialog from "./ProjectConfigDialog.svelte";

vi.mock("./api", () => ({
  fetchProjectConfigRaw: vi.fn(),
  validateProjectConfigRaw: vi.fn(),
  saveProjectConfigRaw: vi.fn(),
}));
import { fetchProjectConfigRaw, validateProjectConfigRaw, saveProjectConfigRaw } from "./api";

const showModal = HTMLDialogElement.prototype.showModal;
beforeEach(() => { HTMLDialogElement.prototype.showModal = vi.fn(); });
afterEach(() => { HTMLDialogElement.prototype.showModal = showModal; cleanup(); vi.clearAllMocks(); });

it("loads the raw config into the textarea", async () => {
  vi.mocked(fetchProjectConfigRaw).mockResolvedValue({ text: "name: demo\n", path: "/x/.webmux.yaml", exists: true });
  render(ProjectConfigDialog, { isOpen: true, onclose: vi.fn(), onrestart: vi.fn() });
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("name: demo\n"));
});

it("renders validation errors from Check and keeps the dialog open", async () => {
  vi.mocked(fetchProjectConfigRaw).mockResolvedValue({ text: "profile: {}\n", path: "p", exists: true });
  vi.mocked(validateProjectConfigRaw).mockResolvedValue({ ok: false, errors: [{ path: "profile", message: 'unknown top-level key "profile"' }] });
  const onclose = vi.fn();
  render(ProjectConfigDialog, { isOpen: true, onclose, onrestart: vi.fn() });
  await screen.findByRole("textbox");
  await fireEvent.click(screen.getByRole("button", { name: /check/i }));
  await screen.findByText(/unknown top-level key/);
  expect(onclose).not.toHaveBeenCalled();
});

it("on save with a 422, shows errors and does not close", async () => {
  vi.mocked(fetchProjectConfigRaw).mockResolvedValue({ text: "x\n", path: "p", exists: true });
  vi.mocked(saveProjectConfigRaw).mockResolvedValue({ ok: false, errors: [{ path: "", message: "bad yaml", line: 1 }] });
  const onclose = vi.fn();
  render(ProjectConfigDialog, { isOpen: true, onclose, onrestart: vi.fn() });
  await screen.findByRole("textbox");
  await fireEvent.click(screen.getByRole("button", { name: /save/i }));
  await screen.findByText(/line 1: bad yaml/i);
  expect(onclose).not.toHaveBeenCalled();
});

it("on save with affected profiles, prompts to restart and forwards branches", async () => {
  vi.mocked(fetchProjectConfigRaw).mockResolvedValue({ text: "x\n", path: "p", exists: true });
  vi.mocked(saveProjectConfigRaw).mockResolvedValue({ ok: true, affected: [{ profile: "default", branches: ["feat-a", "feat-b"] }] });
  const onrestart = vi.fn();
  render(ProjectConfigDialog, { isOpen: true, onclose: vi.fn(), onrestart });
  await screen.findByRole("textbox");
  await fireEvent.click(screen.getByRole("button", { name: /save/i }));
  await fireEvent.click(await screen.findByRole("button", { name: /restart/i }));
  expect(onrestart).toHaveBeenCalledWith(["feat-a", "feat-b"]);
});

it("on save with no affected profiles, closes", async () => {
  vi.mocked(fetchProjectConfigRaw).mockResolvedValue({ text: "x\n", path: "p", exists: true });
  vi.mocked(saveProjectConfigRaw).mockResolvedValue({ ok: true, affected: [] });
  const onclose = vi.fn();
  render(ProjectConfigDialog, { isOpen: true, onclose, onrestart: vi.fn() });
  await screen.findByRole("textbox");
  await fireEvent.click(screen.getByRole("button", { name: /save/i }));
  await waitFor(() => expect(onclose).toHaveBeenCalled());
});
```

- [ ] **Step 2: Run** `cd frontend && bunx vitest run src/lib/ProjectConfigDialog.test.ts` → FAIL (no component).

- [ ] **Step 3: Implement the component** — Svelte 5 runes, `BaseDialog` wrapper, a monospace `<textarea>` (`class="font-mono text-[12px]"`, `spellcheck={false}`), `$state` for `text`, `errors: ConfigError[]`, `checking`, `saving`, `pendingRestart: string[] | null`. `onMount`/`$effect` loads via `fetchProjectConfigRaw`. "Check" → `validateProjectConfigRaw`. "Save" → `saveProjectConfigRaw`; `ok:false` → set `errors`; `ok:true` with `affected.length` → set `pendingRestart = affected.flatMap(a => a.branches)` and render an inline confirm ("N session(s) use a changed layout. Restart now?") with "Restart" → `onrestart(pendingRestart); onclose()` and "Later" → `onclose()`; `ok:true` empty → `onclose()`. Render `errors` as `<li>{e.line ? \`line ${e.line}: \` : ""}{e.path ? \`${e.path} — \` : ""}{e.message}</li>`.

- [ ] **Step 4: Run** → PASS. Also run the svelte MCP autofixer on the new component and fix anything it flags.

- [ ] **Step 5: Commit** `git commit -m "feat(frontend): ProjectConfigDialog raw .webmux.yaml editor"`

### Task 10: Wire the dialog into `ProjectSwitcher` + `SettingsDialog`

**Files:**
- Modify: `frontend/src/lib/ProjectSwitcher.svelte` — add a ⚙ button on the active-project row that opens `ProjectConfigDialog`; pass `onrestart={(branches) => branches.forEach(restartWorktreeProfile)}` reusing whatever call `App.svelte` already uses for profile-reapply (grep `setWorktreeProfile` in `frontend/src`), or emit an event the parent handles.
- Modify: `frontend/src/lib/SettingsDialog.svelte` — a text button "Edit project config →" that closes Settings and opens `ProjectConfigDialog` (route the open state through the same parent that renders `SettingsDialog`).
- Test: extend `ProjectSwitcher` test if one exists; otherwise a small render test that the ⚙ button opens the dialog (mock `./api`).

- [ ] **Step 1:** failing test for the ⚙ button opening the dialog.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement the wiring.
- [ ] **Step 4:** run the frontend suite `cd frontend && bunx vitest run` → PASS.
- [ ] **Step 5:** commit `git commit -m "feat(frontend): open ProjectConfigDialog from switcher + settings"`

---

## Part 7 — CLI `webmux config`

### Task 11: `bin/src/config-commands.ts`

**Files:**
- Create: `bin/src/config-commands.ts`
- Create: `bin/src/config-commands.test.ts`

**Interfaces:**
- Consumes: `validateProjectConfigYaml` (`backend/src/domain/config-validate.ts` — imported directly, like `bin/src/init.ts` imports from `backend/src/services/init-authoring.ts`), `readRawProjectConfig` (`backend/src/adapters/config.ts`), `createApi` from `@webmux/api-contract`, `CommandUsageError` + `formatServerError` from `./shared`.
- Produces:
  - `type ParsedConfigCommand = { subcommand: "show" } | { subcommand: "validate"; path: string } | { subcommand: "edit" }`
  - `parseConfigArgs(args: string[]): ParsedConfigCommand | null`
  - `getConfigUsage(): string`
  - `runConfigCommand(args: string[], port: number, deps?: { editor?: (file: string) => Promise<number> }): Promise<number>`

- [ ] **Step 1: Write failing tests**

```ts
// bin/src/config-commands.test.ts
import { describe, expect, it } from "bun:test";
import { parseConfigArgs, runConfigCommand } from "./config-commands";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseConfigArgs", () => {
  it("parses show / validate / edit", () => {
    expect(parseConfigArgs(["show"])).toEqual({ subcommand: "show" });
    expect(parseConfigArgs(["validate"])).toEqual({ subcommand: "validate", path: "." });
    expect(parseConfigArgs(["validate", "/tmp/x"])).toEqual({ subcommand: "validate", path: "/tmp/x" });
    expect(parseConfigArgs(["edit"])).toEqual({ subcommand: "edit" });
  });
  it("returns null for help", () => {
    expect(parseConfigArgs([])).toBeNull();
    expect(parseConfigArgs(["--help"])).toBeNull();
  });
  it("throws on unknown subcommand", () => {
    expect(() => parseConfigArgs(["frobnicate"])).toThrow();
  });
});

describe("runConfigCommand validate", () => {
  it("exits 1 and prints errors for an invalid config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-cfg-"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    writeFileSync(join(dir, ".webmux.yaml"), "profile: {}\n");
    try {
      const code = await runConfigCommand(["validate", dir], 5111);
      expect(code).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("exits 0 for a valid config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-cfg-"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    writeFileSync(join(dir, ".webmux.yaml"), "name: ok\n");
    try {
      expect(await runConfigCommand(["validate", dir], 5111)).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run** `cd bin && bun test src/config-commands.test.ts` → FAIL.

- [ ] **Step 3: Implement.**
  - `parseConfigArgs` mirrors `parseProjectArgs` in `bin/src/project-commands.ts` (help → null, unknown → `throw new CommandUsageError(...)`).
  - `show`: `const { text, path, exists } = readRawProjectConfig(resolve(process.cwd()))`; print `path` then `text` (or "no .webmux.yaml — using defaults" when `!exists`); return 0.
  - `validate`: `const { text } = readRawProjectConfig(resolve(process.cwd(), parsed.path))`; `const r = validateProjectConfigYaml(text)`; if `r.ok` print "✓ .webmux.yaml is valid", return 0; else print each `error` as `  ${line ? \`line ${line}: \` : ""}${path ? path + " — " : ""}${message}` and return 1.
  - `edit`: read raw; write to a temp file; `deps.editor ?? defaultEditor` (spawn `$EDITOR`/`vi` on the temp file, inherit stdio); re-read; `validateProjectConfigYaml`; on errors print + re-open (loop, max 5 rounds, or abort on empty diff); on success PUT via `createApi(\`http://localhost:${port}\`).saveProjectConfigRaw({ body: { text } })` and print the `affected` summary (or "Saved."). Handle the 422 body defensively even though local validation already passed.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(cli): webmux config show/validate/edit"`

### Task 12: Dispatch `webmux config` from `webmux.ts`

**Files:**
- Modify: `bin/src/webmux.ts` — add `"config"` to the `RootCommand` union (line ~57), to `parseRootArgs`' command recognition (line ~73 area), add a dispatch block mirroring the `project` block (line ~309), and a line in the top-of-file usage text (line ~20).
- Test: `bin/src/webmux.test.ts` (append a case that `webmux config --help` exits 0 / prints usage, if that file exercises dispatch; otherwise rely on Task 11 tests).

- [ ] **Step 1:** add a failing test (`webmux config validate <good repo>` exits 0 through the real dispatch) if `webmux.test.ts` supports it; else skip to Step 3 and note it.
- [ ] **Step 2:** run → FAIL / N/A.
- [ ] **Step 3:** implement:

```ts
// in the dispatch chain, after the project block
if (parsed.command === "config") {
  const { runConfigCommand } = await import("./config-commands.ts");
  process.exit(await runConfigCommand(parsed.commandArgs, effectivePort));
}
```
Add `config` to `reachesAProject`'s OR-list only if `show`/`edit` need the live server (they do for `edit`); `validate` must still work with no server — `runConfigCommand` already handles that per-subcommand, so leave the `warnIfOtherInstances` guard off for `config` to keep `validate` server-free.

- [ ] **Step 4:** run `cd bin && bun test` → PASS.
- [ ] **Step 5:** commit `git commit -m "feat(cli): wire webmux config into the root dispatcher"`

---

## Part 8 — `projectInitCommand` resolution

### Task 13: `global-config.ts`

**Files:**
- Create: `backend/src/adapters/global-config.ts`
- Test: `backend/src/__tests__/global-config.test.ts`

**Interfaces:**
- Produces:
  - `interface GlobalConfig { projectInitCommand?: string }`
  - `readGlobalConfig(file?: string): GlobalConfig` — reads `~/.webmux/config.json`; malformed/missing → `{}`. Sync `node:fs` (match `projects-registry.ts`).
  - `resolveProjectInitCommand(env?: Record<string, string | undefined>, file?: string): string` — `env.WEBMUX_PROJECT_INIT_COMMAND?.trim()` || `readGlobalConfig(file).projectInitCommand?.trim()` || `"webmux init"`.

- [ ] **Step 1: Write failing tests**

```ts
import { expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig, resolveProjectInitCommand } from "../adapters/global-config";

it("defaults to 'webmux init'", () => {
  expect(resolveProjectInitCommand({}, "/nonexistent/config.json")).toBe("webmux init");
});
it("env var wins over the file and the default", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-gc-"));
  const f = join(dir, "config.json");
  writeFileSync(f, JSON.stringify({ projectInitCommand: "from-file" }));
  try {
    expect(resolveProjectInitCommand({ WEBMUX_PROJECT_INIT_COMMAND: "from-env" }, f)).toBe("from-env");
    expect(resolveProjectInitCommand({}, f)).toBe("from-file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("ignores a malformed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-gc-"));
  const f = join(dir, "config.json");
  writeFileSync(f, "{not json");
  try { expect(readGlobalConfig(f)).toEqual({}); } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `cd backend && bun test src/__tests__/global-config.test.ts` → FAIL.
- [ ] **Step 3: Implement** (mirror `projects-registry.ts` read/parse shape; `defaultFile = join(homedir(), ".webmux", "config.json")`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(config): ~/.webmux/config.json + resolveProjectInitCommand"`

---

## Part 9 — Setup terminal backend

### Task 14: `runSetupSession` in the terminal adapter

**Files:**
- Modify: `backend/src/adapters/terminal.ts` — add `runSetupSession`, add `wm-setup-<port>-` to `SESSION_PREFIX` sweeping in `cleanupStaleSessions`.
- Test: `backend/src/__tests__/terminal-adapter.test.ts` (append, reuse the deferred-number / stubbed-spawn helpers already in that file and `setTerminalAdapterDependenciesForTests`).

**Interfaces:**
- Consumes: existing `sessions` map, `spawnPtyProcess`, `spawnTmuxProcess`, `buildPtyArgs`, `MAX_SCROLLBACK_BYTES`.
- Produces:
  - `const SETUP_PREFIX = \`wm-setup-${DASH_PORT}-\`;`
  - `runSetupSession(input: { setupId: string; command: string; cwd: string; cols: number; rows: number; onExit: (exitCode: number) => void }): Promise<void>` — creates its own owner tmux session `\`${SETUP_PREFIX}${setupId}\`` running `bash -ic '<command> "$@"' _ <cwd-path>` **with the repo path already appended by the caller** (so `command` is the full command line), `-c <cwd>`; then attaches a PTY exactly as `attach()` does (same `sessions.set`, scrollback capture, resize support). When the tmux session ends, invoke `onExit` with the code and delete the session entry.
  - `killSetupSession(setupId: string): void`

- [ ] **Step 1: Write the failing test**

```ts
it("runSetupSession creates a wm-setup session and fires onExit when it ends", async () => {
  // configure stubbed spawnTmux to record args, stubbed pty to a closable stream
  const created: string[][] = [];
  setTerminalAdapterDependenciesForTests({
    spawnTmuxProcess: (args) => { created.push(args); return fakeTmuxProc(0); },
    spawnPtyProcess: () => fakePtyProc(), // exposes .exited resolvable
  });
  const exit = deferredNumber();
  await runSetupSession({ setupId: "abc", command: "webmux init '/repo'", cwd: "/repo", cols: 80, rows: 24, onExit: exit.resolve });
  expect(created.some((a) => a.join(" ").includes("wm-setup-") && a.join(" ").includes("new-session"))).toBe(true);
  // simulate the pty/session ending
  fakePtyProc.__end(0);
  expect(await exit.promise).toBe(0);
});
```

(Adapt to the file's actual stub helpers — match `terminal-adapter.test.ts`'s existing patterns for `attach`.)

- [ ] **Step 2: Run** `cd backend && bun test src/__tests__/terminal-adapter.test.ts -t "runSetupSession"` → FAIL.
- [ ] **Step 3: Implement** `runSetupSession` + `killSetupSession`; extend `cleanupStaleSessions` to also sweep names starting with `SETUP_PREFIX`.
- [ ] **Step 4: Run** `cd backend && bun test src/__tests__/terminal-adapter.test.ts` → PASS (all).
- [ ] **Step 5: Commit** `git commit -m "feat(terminal): runSetupSession owns a wm-setup tmux session"`

### Task 15: Hub route `POST /api/setup-terminal` + `/ws/setup/:setupId`

**Files:**
- Modify: `packages/api-contract/src/schemas.ts` + `contract.ts` — `CreateSetupTerminalRequestSchema = z.object({ path: z.string() })`, `CreateSetupTerminalResponseSchema = z.object({ setupId: z.string() })`, path `createSetupTerminal: "/api/setup-terminal"`.
- Modify: `backend/src/server.ts` — `apiCreateSetupTerminal`, the `/ws/setup/:setupId` upgrade + handler, discriminated `SetupTerminalWsData`.
- Test: `backend/src/__tests__/setup-terminal.test.ts` (create) — cover the pure registry-diff helper.

**Interfaces:**
- Consumes: `runSetupSession`, `killSetupSession` (Task 14); `resolveProjectInitCommand` (Task 13); `projectsRegistry` (`manager` / `createProjectsRegistry` — grep how `apiAddProject` reaches the registry; the hub has a `projectsRegistry` in scope near `apiAddProject`); `isGitRepo`, `projectRoot`; `reloadRoutes`; `toProjectSummary`.
- Produces:
  - pure `detectNewProject(before: string[], after: { path: string; prefix: string; name: string }[]): { path: string; prefix: string; name: string } | null`
  - `type SetupTerminalWsData = { kind: "setup-terminal"; setupId: string; beforePaths: string[]; attached: boolean }`
  - WS outbound message `{ type: "setup-complete"; exitCode: number; project: ProjectSummary | null }` (discriminated-union member alongside the existing terminal WS messages)

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/__tests__/setup-terminal.test.ts
import { expect, it } from "bun:test";
import { detectNewProject } from "../setup-terminal-detect";

it("detectNewProject returns the entry whose path is new", () => {
  const before = ["/a", "/b"];
  const after = [
    { path: "/a", prefix: "a", name: "A" },
    { path: "/b", prefix: "b", name: "B" },
    { path: "/c", prefix: "c", name: "C" },
  ];
  expect(detectNewProject(before, after)).toEqual({ path: "/c", prefix: "c", name: "C" });
});
it("returns null when nothing new registered", () => {
  expect(detectNewProject(["/a"], [{ path: "/a", prefix: "a", name: "A" }])).toBeNull();
});
```

- [ ] **Step 2: Run** `cd backend && bun test src/__tests__/setup-terminal.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - `backend/src/setup-terminal-detect.ts` with `detectNewProject`.
  - `apiCreateSetupTerminal(req)`: parse `{ path }`; `const abs = projectRoot(resolve(path))`; `if (!isGitRepo(abs)) return errorResponse(...)`; `const setupId = crypto.randomUUID()`; snapshot `projectsRegistry.list().map(e => e.path)`; build `const cmd = \`${resolveProjectInitCommand()} ${JSON.stringify(abs)}\``; `void runSetupSession({ setupId, command: cmd, cwd: abs, cols: 80, rows: 24, onExit: (code) => { setupExits.set(setupId, code); } })` (store exits in a `Map` keyed by setupId so a late WS connect still learns the result); respond `201 { setupId }`. Also start a hard 30-min timer that calls `killSetupSession(setupId)`.
  - `/ws/setup/:setupId` upgrade in the **hub** route set (same block as `/api/projects`), `data: { kind: "setup-terminal", setupId, beforePaths, attached: false }`.
  - In the shared `websocket` message/open handlers, branch on `data.kind === "setup-terminal"`: on open, `attach` the PTY for `SETUP_PREFIX + setupId` and stream like a normal terminal; forward input/resize; when `runSetupSession`'s `onExit` fires (or `setupExits` already has an entry), re-read `projectsRegistry.list()`, `detectNewProject(beforePaths, list.map(toSummaryish))`; if found → `reloadRoutes()` and `send({ type: "setup-complete", exitCode, project: toProjectSummary(found) })`; else `send({ type: "setup-complete", exitCode, project: null })`.
  - Add `SETUP_PREFIX` sweep target name to `cleanupStaleSessions` (done in Task 14).
- [ ] **Step 4: Run** `cd backend && bun test src/__tests__/setup-terminal.test.ts && bunx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(server): setup-terminal route + /ws/setup streaming with project detection"`

---

## Part 10 — Frontend setup terminal

### Task 16: `Terminal.svelte` accepts `setupId`

**Files:**
- Modify: `frontend/src/lib/Terminal.svelte` — make `worktree` optional; add `setupId?: string`; when `setupId` is set, build the WS URL as `${wsBase}/ws/setup/${setupId}` (no `tabId`), and skip worktree-only features (agent-terminal refresh button, drag-drop upload) via `{#if worktree}` guards.
- Test: `frontend/src/lib/Terminal.test.ts` (append) — assert the WS URL uses `/ws/setup/<id>` when `setupId` is provided.

**Interfaces:**
- Consumes: existing `apiBase` / ws base helper in `api.ts`.
- Produces: no new exports; a `setupId` prop and a `onsetupcomplete?: (detail: { exitCode: number; project: { prefix: string; name: string } | null }) => void` callback fired when a `{ type: "setup-complete" }` frame arrives.

- [ ] **Step 1:** failing test for the setup WS URL + `onsetupcomplete` dispatch on a mocked `setup-complete` frame.
- [ ] **Step 2:** run `cd frontend && bunx vitest run src/lib/Terminal.test.ts` → FAIL.
- [ ] **Step 3:** implement the branching; keep all existing worktree behavior unchanged when `setupId` is undefined.
- [ ] **Step 4:** run the Terminal suite → PASS; run the svelte autofixer on the changed component.
- [ ] **Step 5:** commit `git commit -m "feat(frontend): Terminal.svelte can attach to a setup session"`

### Task 17: `SetupTerminalDialog.svelte` + api + entry points

**Files:**
- Create: `frontend/src/lib/SetupTerminalDialog.svelte` + `.test.ts`
- Modify: `frontend/src/lib/api.ts` — `createSetupTerminal(path: string): Promise<{ setupId: string }>` (hub client, `hubApi`).
- Modify: `frontend/src/lib/EmptyProjects.svelte` — second button "Add & run setup" → opens `SetupTerminalDialog` with the typed path.
- Modify: `frontend/src/lib/ProjectSwitcher.svelte` — same second button in the add-project row.

**Interfaces:**
- Consumes: `createSetupTerminal` (api), `Terminal.svelte` with `setupId` + `onsetupcomplete` (Task 16), `BaseDialog`.
- Produces: `SetupTerminalDialog` props `{ path: string; onclose: () => void }`. On mount → `createSetupTerminal(path)` → render `<Terminal setupId onsetupcomplete>`. On `setup-complete` with a `project` → show "Open {name}" button → `window.location.assign(\`/${project.prefix}/\`)`. With `project: null` → show `Setup exited (code N)` + "Close".

- [ ] **Step 1: Write failing tests**

```ts
// frontend/src/lib/SetupTerminalDialog.test.ts
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupTerminalDialog from "./SetupTerminalDialog.svelte";

vi.mock("./api", () => ({ createSetupTerminal: vi.fn(), apiBase: "" }));
vi.mock("./Terminal.svelte", () => ({
  default: vi.fn(), // replaced with a stub that exposes onsetupcomplete via a global
}));
```

Use a Terminal stub component (a tiny `.svelte` test double, or `vi.mock` returning a component that calls `onsetupcomplete` when a button is clicked) to drive:
- `createSetupTerminal` called with the path on mount.
- after `onsetupcomplete({ exitCode: 0, project: { prefix: "demo", name: "Demo" } })` → an "Open Demo" button appears; clicking it assigns `window.location`.
- after `onsetupcomplete({ exitCode: 1, project: null })` → "exited (code 1)" text + "Close" button calling `onclose`.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement `createSetupTerminal` (hub client — mirror `addProject` in `api.ts`), the dialog, and the two entry-point buttons. Guard `window.location.assign` behind a tiny helper so the test can spy it (there is likely already a navigation helper — grep `location.assign` in `frontend/src`).
- [ ] **Step 4:** run `cd frontend && bunx vitest run` → PASS (whole suite).
- [ ] **Step 5:** commit `git commit -m "feat(frontend): SetupTerminalDialog + Add & run setup entry points"`

---

## Part 11 — Docs + parity check

### Task 18: README + parity note

**Files:**
- Modify: `README.md` — one short paragraph: the dashboard can edit `.webmux.yaml` (⚙ on a project) and add a project by running an interactive setup command (`WEBMUX_PROJECT_INIT_COMMAND` / `~/.webmux/config.json` `projectInitCommand`, default `webmux init`); CLI equivalents `webmux config show|validate|edit`.

- [ ] **Step 1:** write the paragraph next to the existing config/worktree docs.
- [ ] **Step 2:** run the whole test matrix:

```bash
cd backend && bun test
cd ../frontend && bunx vitest run
cd ../bin && bun test
cd ../packages/api-contract && bunx tsc --noEmit
cd ../.. && cd backend && bunx tsc --noEmit && cd ../frontend && bunx tsc --noEmit
```
Expected: all green.

- [ ] **Step 3:** commit `git commit -m "docs: project config editor + setup terminal"`

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §1 strict validator `validateProjectConfigYaml` + `ConfigError` | 1 |
| §1 anti-drift: predicates shared with `adapters/config.ts` | 2 |
| §1 valid config → same `ProjectConfig` as parser | 1 (Step 1 test), 2 |
| §2 backend `GET/POST validate/PUT` routes | 6, 7 |
| §2 `persistProjectConfig` writes shared `.webmux.yaml` | 4 |
| §2 reload in-memory config after save | 3, 7 |
| §2 `affected` profiles + restart prompt | 7 (compute), 9 (prompt), 10 (perform) |
| §2 `ProjectConfigDialog` raw textarea + Check + Save + 422 | 8, 9 |
| §2 entry points (switcher gear, settings link) | 10 |
| §3 configurable `projectInitCommand` (env → file → default) | 13 |
| §3 `runSetupSession` owning a `wm-setup-*` session | 14 |
| §3 `POST /api/setup-terminal` + `/ws/setup/:setupId` | 15 |
| §3 registry-diff → `setup-complete` → open project | 15, 16, 17 |
| §3 `wm-setup-` in `cleanupStaleSessions` | 14 |
| §3 interactive shell so aliases resolve (`bash -ic`) | 14 |
| §3 `projectInitCommand` on `getFrontendConfig` | 7 |
| §3 "Add & run setup" buttons | 17 |
| §4 `webmux config show/validate/edit` | 11, 12 |
| §4 shared validator, `validate` server-free | 11, 12 |
| §Error handling: invalid never written | 7 (422 before persist) |
| §Error handling: non-repo path → 400 | 15 |
| §Error handling: setup WS drop, 30-min ceiling | 15 (timer), 14 |
| §Testing summary table | every task's Test line + Task 18 Step 2 |

Gaps: the spec's "integrations / alerts / oneshot / auto_name shape checks" in the validator are described but only sketched in Task 1 Step 3 (a `// (Implement the same key/type rules...)` comment). **Resolution:** Task 1 Step 3's prose explicitly instructs implementing those branches with the same rules the `parse*` helpers in `adapters/config.ts` apply; the test table (Step 1) covers the load-bearing cases (panes, defaultAgent, docker image, unknown keys). Acceptable — the panes are the user's actual goal and are fully specified.

**2. Placeholder scan** — Task 1 Step 3 and Task 15 Step 3 give module shapes with named follow-through rather than 100% literal final source. Every such spot names the exact rules to apply and the sibling file to copy from, and each has concrete failing tests that pin behavior. No `TBD`/`TODO`/"add error handling" left vague. The `makeServiceWithOpenWorktree` helper in Task 5 is explicitly "add if missing, mirror `setWorktreeProfile`'s test".

**3. Type consistency** — `ConfigError { path; message; line? }` identical across Task 1, 6, 8, 9, 11. `ValidateResult` union `{ ok: true; config } | { ok: false; errors }` consistent Task 1↔7↔11. `affected: { profile: string; branches: string[] }[]` identical Task 6, 7, 9. `computeAffectedProfiles(prev, next, running)` signature matches between Task 7 Step 1 test and Step 3 impl. `runSetupSession` input object identical Task 14 ↔ 15. `detectNewProject(before: string[], after: {path,prefix,name}[])` identical Task 15 test ↔ impl. `resolveProjectInitCommand(env?, file?)` identical Task 13 ↔ 7 ↔ 15 (callers pass no args → defaults). `setup-complete` message `{ type; exitCode; project }` identical Task 15 ↔ 16 ↔ 17.

Fixes applied inline: none needed beyond the notes above.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-30-webmux-project-config-and-setup-terminal.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
