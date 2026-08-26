import { log } from "../lib/log";

/** Deep link into a specific workspace, e.g. for a push notification or
 *  Discord message: `<EXTERNAL_URL>/<prefix>?workspace=<branch>`. Null when
 *  EXTERNAL_URL isn't configured — there's nowhere to link to. */
export function buildWorkspaceDeepLink(input: { externalUrl?: string; prefix?: string; branch: string }): string | null {
  const externalUrl = input.externalUrl?.trim();
  if (!externalUrl) return null;
  const base = externalUrl.replace(/\/+$/, "");
  const path = input.prefix ? `/${input.prefix}` : "";
  const params = new URLSearchParams({ workspace: input.branch });
  return `${base}${path}?${params.toString()}`;
}

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DISCORD_DETAIL_MAX_LENGTH = 1500;

export function buildDiscordMessage(input: {
  projectName: string;
  message: string;
  url: string | null;
  /** Notification time (ms epoch) — rendered via Discord's `<t:...>` markup so
   *  it shows in each reader's local time instead of a fixed-format string. */
  timestamp?: number;
  /** The agent's last text reply, when one could be recovered (e.g. for
   *  "agent stopped" — its final message or question). Rendered as a
   *  blockquote so real newlines from the agent's reply survive intact. */
  detail?: string | null;
}): string {
  const lines = [`**${input.projectName}** — ${input.message}`];
  if (input.timestamp !== undefined) {
    lines.push(`<t:${Math.floor(input.timestamp / 1000)}:f>`);
  }
  if (input.detail) {
    const detail = input.detail.length > DISCORD_DETAIL_MAX_LENGTH
      ? `${input.detail.slice(0, DISCORD_DETAIL_MAX_LENGTH)}…`
      : input.detail;
    lines.push(
      "",
      detail
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    );
  }
  if (input.url) lines.push(input.url);
  const full = lines.join("\n");
  return full.length > DISCORD_MESSAGE_MAX_LENGTH ? `${full.slice(0, DISCORD_MESSAGE_MAX_LENGTH - 1)}…` : full;
}

/** Discord webhook `username`/`avatar_url` overrides for a given agent, so a
 *  notification shows up as "Claude" or "OpenCode" (with their icon) rather
 *  than the webhook's own configured name. */
export interface DiscordAgentIdentity {
  username: string;
  avatarUrl?: string;
}

const DEFAULT_AGENT_IDENTITIES: Record<string, DiscordAgentIdentity> = {
  claude: {
    username: "Claude",
    avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/3840px-Claude-ai-icon.svg.png",
  },
  codex: { username: "Codex" },
  opencode: { username: "OpenCode" },
};

/** Resolves the Discord identity for a builtin agent id. `avatarUrlOverrides`
 *  lets each agent's avatar be configured (e.g. via DISCORD_AVATAR_OPENCODE)
 *  without hardcoding a URL here for agents with no known-stable default.
 *  Returns null for an unrecognized/custom agent id or a null id (branch has
 *  no session yet) — the webhook then falls back to its own configured name. */
export function resolveDiscordAgentIdentity(
  agentId: string | null,
  avatarUrlOverrides: Partial<Record<string, string>> = {},
): DiscordAgentIdentity | null {
  if (!agentId) return null;
  const base = DEFAULT_AGENT_IDENTITIES[agentId];
  if (!base) return null;
  const avatarUrl = avatarUrlOverrides[agentId]?.trim() || base.avatarUrl;
  return { username: base.username, ...(avatarUrl ? { avatarUrl } : {}) };
}

export interface DiscordWebhookPayload {
  content: string;
  username?: string;
  avatarUrl?: string;
}

export interface DiscordSender {
  post(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void>;
}

export const fetchDiscordSender: DiscordSender = {
  async post(webhookUrl, payload) {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: payload.content,
        ...(payload.username ? { username: payload.username } : {}),
        ...(payload.avatarUrl ? { avatar_url: payload.avatarUrl } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`Discord webhook returned ${resp.status}: ${await resp.text()}`);
    }
  },
};

export async function sendDiscordAlert(
  webhookUrl: string,
  input: {
    projectName: string;
    message: string;
    url: string | null;
    identity?: DiscordAgentIdentity | null;
    timestamp?: number;
    detail?: string | null;
  },
  sender: DiscordSender = fetchDiscordSender,
): Promise<void> {
  try {
    await sender.post(webhookUrl, {
      content: buildDiscordMessage(input),
      username: input.identity?.username,
      avatarUrl: input.identity?.avatarUrl,
    });
  } catch (error) {
    log.error(`[alert-delivery] Discord webhook failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
