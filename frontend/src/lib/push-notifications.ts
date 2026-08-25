import { fetchPushPublicKey, subscribePush, unsubscribePush } from "./api";

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Web Push wants the VAPID public key as a raw `Uint8Array`, but the server
 *  hands it over as URL-safe base64 (see PushPublicKeyResponseSchema). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type PushPermissionState = "unsupported" | "default" | "denied" | "subscribed";

export async function currentPushState(): Promise<PushPermissionState> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "subscribed" : "default";
}

/** Requests notification permission, subscribes via the service worker's
 *  PushManager, and registers the subscription with the backend. Throws if
 *  the user denies permission or push isn't supported — callers should show
 *  that as an error rather than silently no-op. */
export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) throw new Error("Push notifications aren't supported in this browser");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");

  const registration = await navigator.serviceWorker.register("/sw.js");
  const { publicKey } = await fetchPushPublicKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Browser returned an incomplete push subscription");
  }
  await subscribePush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
}

export async function disablePushNotifications(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await unsubscribePush(endpoint);
}
