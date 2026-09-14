/**
 * The buzz in somebody's pocket.
 *
 * Called every few minutes by the till's Worker (worker/index.ts, on its
 * cron), exactly as the nightly error-digest is, and proves it is the Worker
 * with a shared PUSH_SECRET. It reads every subscribed phone (push_due, 0101)
 * with the service role, decides what — if anything — each is worth being
 * told (rules.ts), and sends it encrypted end to end (webpush.ts).
 *
 * Fails closed in every direction: no secret configured, nothing happens; no
 * VAPID keys configured, nothing happens and the log says which. A push that
 * cannot be signed is better than one sent to nobody in particular.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { whatToSay } from "./rules.ts";
import { encryptPayload, vapidAuth } from "./webpush.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Who the push service should complain to about us (RFC 8292 §2.1). */
const SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:till@innovaearth.com";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);

  const secret = Deno.env.get("PUSH_SECRET");
  if (!secret) {
    console.error("push: PUSH_SECRET is not set, so nothing is sent");
    return json({ ok: false, sent: 0, why: "not configured" }, 503);
  }
  if (req.headers.get("x-push-secret") !== secret) return json({ ok: false }, 403);

  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    console.error("push: VAPID keys are not set, so nothing is sent");
    return json({ ok: false, sent: 0, why: "no keys" }, 503);
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("push_due", { p_today: today });
  if (error) {
    console.error("push: could not read the subscriptions", error.message);
    return json({ ok: false }, 500);
  }

  const rows = (data ?? []) as {
    id: string; endpoint: string; p256dh: string; auth: string;
    approvals: number; deliveries_late: number; last_sent: string | null;
  }[];

  let sent = 0;
  let quiet = 0;
  for (const row of rows) {
    const say = whatToSay(
      { approvals: row.approvals, deliveries_late: row.deliveries_late },
      row.last_sent, now,
    );
    if (!say) {
      quiet++;
      continue;
    }
    try {
      const body = await encryptPayload(
        JSON.stringify({ title: say.title, body: say.body, tag: say.tag }),
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
      );
      const res = await fetch(row.endpoint, {
        method: "POST",
        headers: {
          Authorization: await vapidAuth(row.endpoint, SUBJECT, publicKey, privateKey),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          // Four hours: a manager who picks the phone up at lunch still wants
          // to know, and by supper the shop has moved on.
          TTL: "14400",
          Urgency: "high",
        },
        body,
      });
      if (res.ok) {
        sent++;
        await supabase.rpc("push_sent", { p_id: row.id, p_signature: say.signature });
      } else {
        // 404 and 410 mean the browser threw the subscription away. Anything
        // else might be the push service having a bad minute, so it takes
        // three before the row goes (0101).
        const gone = res.status === 404 || res.status === 410;
        console.error("push: refused", res.status, gone ? "(gone)" : "");
        await supabase.rpc("push_sent", {
          p_id: row.id, p_signature: say.signature,
          p_failed: true, p_gone: gone,
        });
      }
    } catch (e) {
      console.error("push: could not send", e instanceof Error ? e.message : e);
    }
  }

  return json({ ok: true, sent, quiet, phones: rows.length });
});
