import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fetchPushPublicKey: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));

import { currentPushState, disablePushNotifications, enablePushNotifications, isPushSupported } from "./push-notifications";
import { fetchPushPublicKey, subscribePush, unsubscribePush } from "./api";

describe("push-notifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("isPushSupported", () => {
    it("is false when serviceWorker/PushManager/Notification aren't present", () => {
      expect(isPushSupported()).toBe(false);
    });

    it("is true when all three APIs are present", () => {
      vi.stubGlobal("navigator", { ...navigator, serviceWorker: {} });
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("Notification", class {});
      expect(isPushSupported()).toBe(true);
    });
  });

  describe("currentPushState", () => {
    it("returns unsupported when push isn't available", async () => {
      expect(await currentPushState()).toBe("unsupported");
    });

    it("returns denied when permission was denied", async () => {
      vi.stubGlobal("navigator", { ...navigator, serviceWorker: {} });
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("Notification", { permission: "denied" });
      expect(await currentPushState()).toBe("denied");
    });

    it("returns subscribed when a subscription already exists", async () => {
      vi.stubGlobal("Notification", { permission: "default" });
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("navigator", {
        ...navigator,
        serviceWorker: {
          getRegistration: async () => ({
            pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/1" }) },
          }),
        },
      });
      expect(await currentPushState()).toBe("subscribed");
    });

    it("returns default when no subscription exists", async () => {
      vi.stubGlobal("Notification", { permission: "default" });
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("navigator", {
        ...navigator,
        serviceWorker: {
          getRegistration: async () => ({
            pushManager: { getSubscription: async () => null },
          }),
        },
      });
      expect(await currentPushState()).toBe("default");
    });
  });

  describe("enablePushNotifications", () => {
    beforeEach(() => {
      vi.mocked(fetchPushPublicKey).mockResolvedValue({ publicKey: "AAAA" });
      vi.mocked(subscribePush).mockResolvedValue({ ok: true });
    });

    it("throws when push isn't supported", async () => {
      await expect(enablePushNotifications()).rejects.toThrow(/aren't supported/i);
    });

    it("throws when permission is denied", async () => {
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("Notification", { requestPermission: async () => "denied" });
      vi.stubGlobal("navigator", { ...navigator, serviceWorker: {} });

      await expect(enablePushNotifications()).rejects.toThrow(/permission/i);
    });

    it("subscribes and registers the subscription with the backend", async () => {
      const subscribeMock = vi.fn().mockResolvedValue({
        toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }),
      });
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
      vi.stubGlobal("navigator", {
        ...navigator,
        serviceWorker: {
          register: async () => ({ pushManager: { subscribe: subscribeMock } }),
        },
      });

      await enablePushNotifications();

      expect(subscribeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userVisibleOnly: true }),
      );
      expect(subscribePush).toHaveBeenCalledWith({
        endpoint: "https://push.example/1",
        keys: { p256dh: "p", auth: "a" },
      });
    });
  });

  describe("disablePushNotifications", () => {
    it("does nothing when there's no active subscription", async () => {
      vi.stubGlobal("navigator", {
        ...navigator,
        serviceWorker: { getRegistration: async () => undefined },
      });

      await disablePushNotifications();

      expect(unsubscribePush).not.toHaveBeenCalled();
    });

    it("unsubscribes locally and notifies the backend", async () => {
      const unsubscribeMock = vi.fn().mockResolvedValue(true);
      vi.mocked(unsubscribePush).mockResolvedValue({ ok: true });
      vi.stubGlobal("navigator", {
        ...navigator,
        serviceWorker: {
          getRegistration: async () => ({
            pushManager: {
              getSubscription: async () => ({ endpoint: "https://push.example/1", unsubscribe: unsubscribeMock }),
            },
          }),
        },
      });

      await disablePushNotifications();

      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
      expect(unsubscribePush).toHaveBeenCalledWith("https://push.example/1");
    });
  });
});
