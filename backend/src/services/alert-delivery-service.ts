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

export function buildDiscordMessage(input: { projectName: string; message: string; url: string | null }): string {
  const lines = [`**${input.projectName}** — ${input.message}`];
  if (input.url) lines.push(input.url);
  return lines.join("\n");
}

export interface DiscordSender {
  post(webhookUrl: string, content: string): Promise<void>;
}

export const fetchDiscordSender: DiscordSender = {
  async post(webhookUrl, content) {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) {
      throw new Error(`Discord webhook returned ${resp.status}: ${await resp.text()}`);
    }
  },
};

export async function sendDiscordAlert(
  webhookUrl: string,
  input: { projectName: string; message: string; url: string | null },
  sender: DiscordSender = fetchDiscordSender,
): Promise<void> {
  try {
    await sender.post(webhookUrl, buildDiscordMessage(input));
  } catch (error) {
    log.error(`[alert-delivery] Discord webhook failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
