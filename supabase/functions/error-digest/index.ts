/**
 * The nightly line in InnovaEarth's inbox.
 *
 * Called once a day by the till's Worker (worker/index.ts, on its cron) with
 * the public key. Reads the last day of what the tills reported
 * (client_errors, 0078) and what they asked TillAI (tillai_questions, 0075)
 * with the service role, and sends one email through Resend, the way the
 * landing page's request form does. A quiet night sends nothing.
 *
 * Whoever calls this cannot make it send twice: it keeps its own memory in
 * ops_digests and refuses to go out again within twenty hours of the last
 * one. That is the whole of the guard, and it is enough, because the only
 * harm a stranger with the public key could do is bring the nightly email
 * forward.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { summarise } from "./digest.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const TO = Deno.env.get("POS_REQUEST_TO") ?? "ehsan@innovaearth.com";
// From an address on innovaearth.com, which is verified in Resend; the
// sandbox sender only delivers to the Resend account's own address.
const FROM = Deno.env.get("RESEND_FROM") ?? "InnovaPOS <till@innovaearth.com>";
const MIN_GAP_MS = 20 * 3600_000;
const WINDOW_MS = 24 * 3600_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);

  // Only the Worker's cron calls this, and it says so with a secret the two
  // share (DIGEST_SECRET on both sides). The public key was all it took
  // before, and the reply carried platform-wide counts to whoever asked.
  // Fails closed: with no secret configured nothing is sent, and the log
  // says why.
  const secret = Deno.env.get("DIGEST_SECRET");
  if (!secret) {
    console.error("DIGEST_SECRET is not set; the digest will not send until it is");
    return json({ ok: false }, 503);
  }
  if (req.headers.get("x-digest-secret") !== secret) return json({ ok: false }, 403);

  const { data: last } = await supabase
    .from("ops_digests").select("sent_at").eq("kind", "nightly")
    .order("sent_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - Date.parse(last.sent_at) < MIN_GAP_MS) {
    return json({ ok: true, sent: false });
  }
  // Claim the day before the work, so two calls at once send one email; the
  // claim is taken back if the mail is refused, so a refusal can be retried.
  const { data: claim } = await supabase
    .from("ops_digests").insert({ kind: "nightly", detail: { claimed: true } }).select("id").single();
  const unclaim = () => claim ? supabase.from("ops_digests").delete().eq("id", claim.id) : Promise.resolve();

  const since = new Date(Date.now() - WINDOW_MS);
  const [{ data: errors }, { data: questions }] = await Promise.all([
    supabase.from("client_errors").select("org_id, register_id, kind, message, at")
      .gte("at", since.toISOString()).order("at", { ascending: false }).limit(2000),
    supabase.from("tillai_questions").select("org_id, unlocked, tools")
      .gte("asked_at", since.toISOString()).limit(5000),
  ]);
  const orgIds = [...new Set([...(errors ?? []), ...(questions ?? [])].map((r) => r.org_id))];
  const regIds = [...new Set((errors ?? []).map((r) => r.register_id))];
  const [{ data: orgs }, { data: regs }] = await Promise.all([
    orgIds.length ? supabase.from("organizations").select("id, name").in("id", orgIds) : Promise.resolve({ data: [] }),
    regIds.length ? supabase.from("registers").select("id, name").in("id", regIds) : Promise.resolve({ data: [] }),
  ]);

  const digest = summarise(errors ?? [], questions ?? [], orgs ?? [], regs ?? [], since);
  const record = (detail: unknown) =>
    claim ? supabase.from("ops_digests").update({ detail }).eq("id", claim.id)
          : supabase.from("ops_digests").insert({ kind: "nightly", detail });
  if (!digest) {
    await record({ errors: 0, questions: 0, sent: false });
    return json({ ok: true, sent: false });
  }

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) {
    console.error("RESEND_API_KEY missing; digest built but not sent");
    await unclaim();
    return json({ ok: false, message: "No mail key" }, 500);
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: FROM, to: [TO], subject: digest.subject, html: digest.html, text: digest.text }),
  });
  if (!res.ok) {
    console.error("Resend", res.status, await res.text());
    await unclaim();
    return json({ ok: false, message: "Mail refused" }, 502);
  }
  await record({ errors: digest.errors, questions: digest.questions, sent: true });
  // What was in it is for the inbox, not the caller.
  return json({ ok: true, sent: true });
});
