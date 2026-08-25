import * as webpush from "web-push";
import { log } from "../lib/log";

export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface PushSender {
  send(subscription: StoredPushSubscription, payload: PushPayload, vapid: VapidKeyPair, subject: string): Promise<
    { ok: true } | { ok: false; expired: boolean; error: string }
  >;
}

/** Real sender, backed by the `web-push` library (VAPID signing + AES128GCM
 *  payload encryption per the Web Push protocol). Injected as a dependency so
 *  callers can substitute a fake in tests instead of hitting real push
 *  services with real crypto. */
export const webPushSender: PushSender = {
  async send(subscription, payload, vapid, subject) {
    try {
      webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      return { ok: true };
    } catch (error) {
      // 404/410 means the push service says this subscription is gone for
      // good (browser data cleared, extension uninstalled, etc.) — the
      // caller should stop sending to it.
      const expired = error instanceof webpush.WebPushError && (error.statusCode === 404 || error.statusCode === 410);
      return { ok: false, expired, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

/** Sends one payload to every subscription, tolerating per-subscription
 *  failures. Returns the endpoints that came back expired so the caller can
 *  prune them from the store. */
export async function sendPushToAll(
  subscriptions: StoredPushSubscription[],
  payload: PushPayload,
  vapid: VapidKeyPair,
  subject: string,
  sender: PushSender = webPushSender,
): Promise<{ expiredEndpoints: string[] }> {
  const expiredEndpoints: string[] = [];
  await Promise.all(
    subscriptions.map(async (subscription) => {
      const result = await sender.send(subscription, payload, vapid, subject);
      if (!result.ok) {
        log.debug(`[push] delivery to ${subscription.endpoint} failed: ${result.error}`);
        if (result.expired) expiredEndpoints.push(subscription.endpoint);
      }
    }),
  );
  return { expiredEndpoints };
}

export interface PushSubscriptionStoreDependencies {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
}

/** Persists browser push subscriptions machine-wide (one webmux server, any
 *  number of browsers/devices subscribed to it) as a flat JSON file. */
export class PushSubscriptionStore {
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, contents: string) => Promise<void>;

  constructor(private readonly path: string, deps: PushSubscriptionStoreDependencies = {}) {
    this.readFile = deps.readFile ?? ((p) => Bun.file(p).text());
    this.writeFile = deps.writeFile ?? ((p, contents) => Bun.write(p, contents).then(() => undefined));
  }

  async list(): Promise<StoredPushSubscription[]> {
    try {
      const text = await this.readFile(this.path);
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredPushSubscription[]) : [];
    } catch {
      return [];
    }
  }

  async add(subscription: StoredPushSubscription): Promise<void> {
    const subscriptions = (await this.list()).filter((s) => s.endpoint !== subscription.endpoint);
    subscriptions.push(subscription);
    await this.writeFile(this.path, JSON.stringify(subscriptions, null, 2));
  }

  async remove(endpoints: string[]): Promise<void> {
    if (endpoints.length === 0) return;
    const toRemove = new Set(endpoints);
    const subscriptions = (await this.list()).filter((s) => !toRemove.has(s.endpoint));
    await this.writeFile(this.path, JSON.stringify(subscriptions, null, 2));
  }
}

export interface VapidKeyStoreDependencies {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
  generateKeys?: () => VapidKeyPair;
}

/** Loads the VAPID key pair used to sign push messages, generating and
 *  persisting one on first use. Keys must stay stable across restarts —
 *  regenerating them would invalidate every browser's existing subscription. */
export async function loadOrCreateVapidKeys(path: string, deps: VapidKeyStoreDependencies = {}): Promise<VapidKeyPair> {
  const readFile = deps.readFile ?? ((p) => Bun.file(p).text());
  const writeFile = deps.writeFile ?? ((p, contents) => Bun.write(p, contents).then(() => undefined));
  const generateKeys = deps.generateKeys ?? webpush.generateVAPIDKeys;

  try {
    const text = await readFile(path);
    return JSON.parse(text) as VapidKeyPair;
  } catch {
    const keys = generateKeys();
    await writeFile(path, JSON.stringify(keys, null, 2));
    return keys;
  }
}
