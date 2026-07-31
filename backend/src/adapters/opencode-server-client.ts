import { isRecord } from "../lib/type-guards";

/** Thin client for opencode's local HTTP+SSE server (`opencode serve`), opencode's
 *  documented stable integration surface (https://opencode.ai/docs/server/) — unlike
 *  its on-disk SQLite store, which the maintainers have already broken once across a
 *  storage migration (see https://github.com/anomalyco/opencode/issues/34445). This
 *  plays the same role for opencode that CodexAppServerClient
 *  (backend/src/adapters/codex-app-server.ts) plays for Codex, except the transport
 *  is REST + Server-Sent Events instead of JSON-RPC over stdio: opencode has no
 *  documented JSON-RPC gateway, so a `codex app-server`-shaped client isn't available
 *  to build against.
 *
 *  One server process is started per worktree (scoped to that worktree's cwd, since
 *  opencode associates sessions with the directory the server was launched from) and
 *  reused for the lifetime of the pane. */

export interface OpencodeSessionSummary {
  id: string;
  title: string | null;
  directory: string | null;
  updatedAt: number | null;
}

export interface OpencodeMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpencodeMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | string;
  parts: OpencodeMessagePart[];
  createdAt: number | null;
}

export interface OpencodeServerEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface StartedServer {
  port: number;
  hostname: string;
  proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
}

const DEFAULT_HOSTNAME = "127.0.0.1";
const HEALTH_POLL_ATTEMPTS = 40;
const HEALTH_POLL_DELAY_MS = 150;

function randomPort(): number {
  // Ephemeral range, avoiding the documented default (4096) so a manually-run
  // `opencode serve` on the same box never collides with a webmux-managed one.
  return 30000 + Math.floor(Math.random() * 20000);
}

function baseUrl(server: StartedServer): string {
  return `http://${server.hostname}:${server.port}`;
}

async function waitForHealth(server: StartedServer): Promise<boolean> {
  for (let attempt = 0; attempt < HEALTH_POLL_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl(server)}/global/health`);
      if (response.ok) return true;
    } catch {
      // server not accepting connections yet
    }
    await Bun.sleep(HEALTH_POLL_DELAY_MS);
  }
  return false;
}

export class OpencodeServerProcessError extends Error {}

/** Start a per-worktree `opencode serve` bound to `cwd`, waiting until it answers
 *  its health check. Callers are responsible for calling `stopOpencodeServer` when
 *  the pane / discovery lookup is done with it. */
export async function startOpencodeServer(cwd: string): Promise<StartedServer> {
  const hostname = DEFAULT_HOSTNAME;
  const port = randomPort();
  const proc = Bun.spawn(["opencode", "serve", "--hostname", hostname, "--port", String(port)], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });

  const server: StartedServer = { port, hostname, proc };
  const healthy = await waitForHealth(server);
  if (!healthy) {
    try {
      proc.kill();
    } catch {
      // best-effort
    }
    throw new OpencodeServerProcessError(`opencode serve did not become healthy on port ${port}`);
  }

  return server;
}

export function stopOpencodeServer(server: StartedServer): void {
  try {
    server.proc.kill();
  } catch {
    // best-effort
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** opencode's session/message JSON shape isn't pinned down by a published schema we
 *  can import, so these parsers accept a few plausible field-name variants
 *  (`id`/`sessionID`, `directory`/`projectID`, `time.updated`/`updatedAt`) rather
 *  than asserting one exact shape. */
function parseSessionSummary(raw: unknown): OpencodeSessionSummary | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id) ?? readString(raw.sessionID);
  if (!id) return null;
  const time = isRecord(raw.time) ? raw.time : null;
  const updatedAt = readNumber(raw.updatedAt) ?? readNumber(time?.updated) ?? null;
  return {
    id,
    title: readString(raw.title),
    directory: readString(raw.directory) ?? readString(raw.projectID),
    updatedAt,
  };
}

function parseMessagePart(raw: unknown): OpencodeMessagePart | null {
  if (!isRecord(raw)) return null;
  const type = readString(raw.type);
  if (!type) return null;
  return { ...raw, type };
}

function parseMessage(raw: unknown): OpencodeMessage | null {
  if (!isRecord(raw)) return null;
  // The API may return `{ info, parts }` (message envelope) or a flat message record.
  const info = isRecord(raw.info) ? raw.info : raw;
  const id = readString(info.id) ?? readString(info.messageID);
  const sessionId = readString(info.sessionID) ?? readString(info.sessionId);
  if (!id || !sessionId) return null;
  const role = readString(info.role) ?? "assistant";
  const rawParts = Array.isArray(raw.parts) ? raw.parts : Array.isArray(info.parts) ? info.parts : [];
  const parts = rawParts.map(parseMessagePart).filter((part): part is OpencodeMessagePart => part !== null);
  const time = isRecord(info.time) ? info.time : null;
  const createdAt = readNumber(info.createdAt) ?? readNumber(time?.created) ?? null;
  return { id, sessionId, role, parts, createdAt };
}

export class OpencodeServerClient {
  constructor(private readonly server: StartedServer) {}

  private url(path: string): string {
    return `${baseUrl(this.server)}${path}`;
  }

  async listSessions(): Promise<OpencodeSessionSummary[]> {
    const response = await fetch(this.url("/session"));
    if (!response.ok) return [];
    const parsed: unknown = await response.json().catch(() => null);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseSessionSummary).filter((session): session is OpencodeSessionSummary => session !== null);
  }

  async createSession(title?: string): Promise<OpencodeSessionSummary | null> {
    const response = await fetch(this.url("/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!response.ok) return null;
    return parseSessionSummary(await response.json().catch(() => null));
  }

  async listMessages(sessionId: string): Promise<OpencodeMessage[]> {
    const response = await fetch(this.url(`/session/${encodeURIComponent(sessionId)}/message`));
    if (!response.ok) return [];
    const parsed: unknown = await response.json().catch(() => null);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseMessage).filter((message): message is OpencodeMessage => message !== null);
  }

  /** Send a message and return immediately (202/204) rather than blocking on the
   *  full turn — mirrors how the web chat surfaces streamed progress instead of
   *  waiting for a single synchronous response. */
  async sendMessageAsync(sessionId: string, text: string): Promise<boolean> {
    const response = await fetch(this.url(`/session/${encodeURIComponent(sessionId)}/prompt_async`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    return response.ok;
  }

  async abort(sessionId: string): Promise<boolean> {
    const response = await fetch(this.url(`/session/${encodeURIComponent(sessionId)}/abort`), { method: "POST" });
    return response.ok;
  }

  /** Subscribe to the server's global SSE event stream. Returns an unsubscribe
   *  function; the underlying fetch is aborted when called. */
  subscribe(onEvent: (event: OpencodeServerEvent) => void): () => void {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(this.url("/event"), { signal: controller.signal });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice("data:".length).trim();
            if (!payload) continue;
            try {
              const parsed: unknown = JSON.parse(payload);
              if (isRecord(parsed) && typeof parsed.type === "string") {
                onEvent({ type: parsed.type, properties: isRecord(parsed.properties) ? parsed.properties : undefined });
              }
            } catch {
              // ignore malformed SSE frames
            }
          }
        }
      } catch {
        // stream ended / aborted — nothing to report
      }
    })();

    return () => controller.abort();
  }
}
