import { requireToken } from "./api";
import { supabase } from "./supabase";

/**
 * Being told when the app is shut.
 *
 * The bell (lib/notices) answers "what needs somebody" to anyone looking at
 * the app. This is the other half: a manager whose phone is in a pocket, and
 * a customer standing at the counter waiting for a discount to be approved.
 *
 * Deliberately narrow. Two things are pushed — a sale parked for a manager, a
 * load that should have gone — and the decision about when lives on the
 * server (supabase/functions/push/rules.ts) where it can be held to. This
 * file only does the handshake: ask, subscribe, tell the shop where to send.
 *
 * The public half of the signing key is here in the open because that is what
 * it is: the browser hands it to the push service, which uses it to check
 * that a push really came from this shop's server. The private half never
 * leaves the edge function.
 */
const VAPID_PUBLIC =
  "BDU4kTDcxyG9O9qCbCIzqEAedELwxo53mhJS7Ivw_rnCmOODwNGEmrAWrLbaRe2GDzztBQfHMMxzUn7R4atXlbU";

export type PushState = "unsupported" | "blocked" | "off" | "on";

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  // The buffer is spelled out because applicationServerKey will not take a
  // Uint8Array that might be backed by shared memory.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function keyOf(sub: PushSubscription, name: "p256dh" | "auth"): string {
  const raw = sub.getKey(name);
  if (!raw) return "";
  let s = "";
  for (const b of new Uint8Array(raw)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Can this phone be told at all, and is it already?
 *
 * "unsupported" is the honest answer on an iPhone where the app is being read
 * in Safari rather than from the home screen: iOS gives a web app push only
 * once it has been installed, and offering a switch that cannot work is worse
 * than saying so.
 */
export async function pushState(): Promise<PushState> {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Ask, subscribe, and tell the shop where to send. */
export async function turnPushOn(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const asked = await Notification.requestPermission();
  if (asked !== "granted") return asked === "denied" ? "blocked" : "off";

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Every push must show a notification. The alternative — a site that
      // can be woken silently — is what browsers withdraw permission over.
      userVisibleOnly: true,
      applicationServerKey: base64ToBytes(VAPID_PUBLIC),
    }));

  const { error } = await supabase.rpc("pos_push_subscribe", {
    p_register_token: requireToken(),
    p_endpoint: sub.endpoint,
    p_p256dh: keyOf(sub, "p256dh"),
    p_auth: keyOf(sub, "auth"),
  });
  if (error) {
    // The shop could not record it, so the browser should not be left
    // believing it is subscribed to something nobody will send to.
    await sub.unsubscribe().catch(() => undefined);
    throw error;
  }
  return "on";
}

export async function turnPushOff(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return "off";
  // The shop first: a subscription the browser has dropped but the shop still
  // holds is a push into the void every few minutes until it gives up.
  await supabase.rpc("pos_push_forget", {
    p_register_token: requireToken(),
    p_endpoint: sub.endpoint,
  });
  await sub.unsubscribe().catch(() => undefined);
  return "off";
}
