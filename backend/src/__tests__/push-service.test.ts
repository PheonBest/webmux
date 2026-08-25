import { describe, expect, it } from "bun:test";
import {
  loadOrCreateVapidKeys,
  PushSubscriptionStore,
  sendPushToAll,
  type PushSender,
  type StoredPushSubscription,
} from "../services/push-service";

function fakeFileStore(): { readFile: (p: string) => Promise<string>; writeFile: (p: string, c: string) => Promise<void> } {
  const files = new Map<string, string>();
  return {
    readFile: async (p) => {
      const contents = files.get(p);
      if (contents === undefined) throw new Error(`ENOENT: ${p}`);
      return contents;
    },
    writeFile: async (p, c) => {
      files.set(p, c);
    },
  };
}

describe("sendPushToAll", () => {
  const subscription: StoredPushSubscription = { endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } };
  const vapid = { publicKey: "pub", privateKey: "priv" };

  it("sends to every subscription and reports none expired on success", async () => {
    const sender: PushSender = { send: async () => ({ ok: true }) };
    const result = await sendPushToAll([subscription], { title: "t", body: "b" }, vapid, "mailto:a@b.com", sender);
    expect(result.expiredEndpoints).toEqual([]);
  });

  it("collects endpoints that come back expired (404/410)", async () => {
    const sender: PushSender = { send: async () => ({ ok: false, expired: true, error: "gone" }) };
    const result = await sendPushToAll([subscription], { title: "t", body: "b" }, vapid, "mailto:a@b.com", sender);
    expect(result.expiredEndpoints).toEqual([subscription.endpoint]);
  });

  it("does not report a non-expired failure as expired", async () => {
    const sender: PushSender = { send: async () => ({ ok: false, expired: false, error: "server error" }) };
    const result = await sendPushToAll([subscription], { title: "t", body: "b" }, vapid, "mailto:a@b.com", sender);
    expect(result.expiredEndpoints).toEqual([]);
  });
});

describe("PushSubscriptionStore", () => {
  it("returns an empty list when the file doesn't exist yet", async () => {
    const store = new PushSubscriptionStore("/nowhere.json", fakeFileStore());
    expect(await store.list()).toEqual([]);
  });

  it("adds a subscription and dedupes by endpoint", async () => {
    const deps = fakeFileStore();
    const store = new PushSubscriptionStore("/subs.json", deps);
    const sub: StoredPushSubscription = { endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } };

    await store.add(sub);
    await store.add({ ...sub, keys: { p256dh: "a2", auth: "b2" } });

    const stored = await store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.keys.p256dh).toBe("a2");
  });

  it("removes subscriptions by endpoint", async () => {
    const deps = fakeFileStore();
    const store = new PushSubscriptionStore("/subs.json", deps);
    await store.add({ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } });
    await store.add({ endpoint: "https://push.example/2", keys: { p256dh: "c", auth: "d" } });

    await store.remove(["https://push.example/1"]);

    const stored = await store.list();
    expect(stored.map((s) => s.endpoint)).toEqual(["https://push.example/2"]);
  });
});

describe("loadOrCreateVapidKeys", () => {
  it("generates and persists keys on first use", async () => {
    const deps = fakeFileStore();
    const generated = { publicKey: "pub", privateKey: "priv" };
    const keys = await loadOrCreateVapidKeys("/vapid.json", { ...deps, generateKeys: () => generated });
    expect(keys).toEqual(generated);
    expect(JSON.parse(await deps.readFile("/vapid.json"))).toEqual(generated);
  });

  it("reuses persisted keys on subsequent loads", async () => {
    const deps = fakeFileStore();
    const generateKeys = () => ({ publicKey: "should-not-be-used", privateKey: "should-not-be-used" });
    await loadOrCreateVapidKeys("/vapid.json", { ...deps, generateKeys });

    let calls = 0;
    const keys = await loadOrCreateVapidKeys("/vapid.json", {
      ...deps,
      generateKeys: () => {
        calls += 1;
        return { publicKey: "new", privateKey: "new" };
      },
    });

    expect(calls).toBe(0);
    expect(keys.publicKey).toBe("should-not-be-used");
  });
});
