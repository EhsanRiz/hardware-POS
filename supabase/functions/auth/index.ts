// InnovaPOS auth: OTP enrolment and PIN reset over BulkSMS.
//
// Runs as an edge function rather than a public RPC for two reasons: the
// BulkSMS secret lives here, and a throttle needs a place to hold state. The
// anon key can call this, so every path is rate-limited and every response to
// request_code is uniform — the endpoint must never confirm whether a phone is
// registered, or it becomes a directory of who works where.
//
// A PIN is never sent by SMS. The code authorises the person to CHOOSE a PIN;
// daily sign-in is phone-free (register token + PIN) and works offline.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { inviteMessage } from "./invite-message.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// The uniform reply for request_code, sent whether or not anything happened.
const UNIFORM = { ok: true, message: "If that number is registered, a code has been sent." };

const OTP_TTL_MIN = 10;
const RESEND_COOLDOWN_S = 60;
const DAILY_CAP = 5;      // SMSes cost money; this caps the bill per number
const MAX_VERIFY_ATTEMPTS = 5;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizePhone(raw: string): string | null {
  const p = (raw ?? "").replace(/[\s()-]/g, "");
  // ZA and Lesotho local forms are accepted and normalised; anything already
  // E.164 passes through. Ladybrand sits on the border, so both matter.
  if (/^0\d{9}$/.test(p)) return "+27" + p.slice(1);
  if (/^[5-6]\d{7}$/.test(p)) return "+266" + p;
  if (/^\+\d{9,15}$/.test(p)) return p;
  return null;
}

// The outcome of handing a message to BulkSMS. This function must never throw:
// a thrown network error would escape to the top-level handler and turn into a
// 500 — for registered numbers only, since unregistered ones never reach the
// send. That is a probe's way of telling who works here, on top of being a
// failure nobody recorded.
//
// The reason is written for the manager who will read it on the staff screen.
// Whatever the provider actually said goes to the function log, where an
// operator can see it and a caller cannot.
type SendOutcome = { sent: true } | { sent: false; reason: string };

async function sendSms(phone: string, body: string): Promise<SendOutcome> {
  const id = Deno.env.get("BULKSMS_TOKEN_ID");
  const secret = Deno.env.get("BULKSMS_TOKEN_SECRET");
  if (!id || !secret) {
    console.error("BulkSMS secrets missing; SMS not sent");
    return { sent: false, reason: "SMS sending is not configured" };
  }
  try {
    const res = await fetch("https://api.bulksms.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${id}:${secret}`),
      },
      body: JSON.stringify([{ to: phone, body }]),
    });
    if (!res.ok) {
      console.error("BulkSMS", res.status, await res.text());
      return { sent: false, reason: `The SMS service refused the message (${res.status})` };
    }
    return { sent: true };
  } catch (e) {
    console.error("BulkSMS unreachable", e);
    return { sent: false, reason: "The SMS service could not be reached" };
  }
}

async function requestCode(phone: string, purpose: string) {
  if (purpose !== "enrol" && purpose !== "reset") return UNIFORM;

  // Only invited/active staff get codes — but the caller can't tell.
  const { data: user } = await supabase
    .from("app_users")
    .select("id,status")
    .eq("phone_e164", phone)
    .neq("status", "disabled")
    .maybeSingle();
  if (!user) return UNIFORM;

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { data: recent } = await supabase
    .from("auth_otps")
    .select("created_at,sent_at")
    .eq("phone_e164", phone)
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false });
  // The cap is on the bill, so only messages the provider took count towards
  // it. Five failed attempts cost nothing and must not lock the person out for
  // a day on top of the outage that already failed them.
  const sentToday = (recent ?? []).filter((r) => r.sent_at != null).length;
  if (sentToday >= DAILY_CAP) return UNIFORM;
  // The cooldown counts every attempt, sent or not — it is what stands between
  // a stuck provider and a retry loop hammering it once a render.
  if (recent?.[0] && Date.now() - Date.parse(recent[0].created_at) < RESEND_COOLDOWN_S * 1000) {
    return UNIFORM;
  }

  const code = randomCode();
  const { data: otp } = await supabase
    .from("auth_otps")
    .insert({
      phone_e164: phone,
      purpose,
      code_hash: await sha256(code),
      expires_at: new Date(Date.now() + OTP_TTL_MIN * 60_000).toISOString(),
    })
    .select("id")
    .single();
  // The send happens AFTER the reply, not before it. The body of the reply
  // is uniform, but a registered number used to wait on a round trip to
  // BulkSMS that an unregistered one never made, and that gap — hundreds of
  // milliseconds — was the directory the uniform body exists to deny. The
  // work is handed to the runtime to finish after the response goes out;
  // where that is not available it is awaited, and the floor below still
  // hides most of it.
  const work = (async () => {
    const out = await sendSms(
      phone,
      `InnovaPOS code: ${code}. Valid ${OTP_TTL_MIN} minutes. Never share it.`,
    );
    // The outcome lands on the attempt itself, where pos_admin_list_users can
    // find it and put it on the staff screen. The reply stays uniform either
    // way: the caller may not learn whether the number is registered, but
    // the shop's manager is owed the truth, and this is how it reaches them.
    if (otp) {
      await supabase
        .from("auth_otps")
        .update(out.sent ? { sent_at: new Date().toISOString() } : { send_error: out.reason })
        .eq("id", otp.id);
    }
  })();
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work);
  else await work;
  return UNIFORM;
}

/**
 * Six digits, uniformly drawn. 2^32 is not a multiple of 10^6, so taking a
 * 32-bit word modulo a million favours the low codes very slightly; a draw
 * that falls in the uneven tail is thrown away and taken again.
 */
function randomCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  let n: number;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (n >= limit);
  return String(n % 1_000_000).padStart(6, "0");
}

/** Hold a reply until at least `ms` after `started`: every branch of a uniform answer takes the same time. */
async function floor(started: number, ms: number): Promise<void> {
  const left = started + ms - Date.now();
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

async function verifyCode(phone: string, code: string) {
  // A code that never went out is not a code: nobody legitimate can be holding
  // it, and — because only the newest row is checked — leaving it here would
  // let a failed resend shadow the delivered, still-valid code that came
  // before it.
  const { data: otp } = await supabase
    .from("auth_otps")
    .select("*")
    .eq("phone_e164", phone)
    .eq("used", false)
    .is("send_error", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const fail = { ok: false, message: "That code didn't work. Check it, or request a new one." };
  if (!otp || otp.attempts >= MAX_VERIFY_ATTEMPTS) return fail;

  // Count the attempt before comparing, and count it in the database in one
  // statement (0091): read here, compared here and written back as a number,
  // twenty guesses fired together all read zero, all passed the cap, and the
  // last write left it at one. The refusal is on what the count came back
  // as, so a parallel run through the space burns its five like a serial one.
  const { data: attempts, error: countErr } = await supabase.rpc("auth_otp_attempt", { p_otp_id: otp.id });
  if (countErr || typeof attempts !== "number" || attempts > MAX_VERIFY_ATTEMPTS) return fail;
  if ((await sha256(code)) !== otp.code_hash) return fail;

  await supabase.from("auth_otps").update({ used: true }).eq("id", otp.id);
  const { data: permit } = await supabase
    .from("auth_setpin_tokens")
    .insert({
      phone_e164: phone,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    })
    .select("token")
    .single();
  return { ok: true, token: permit!.token };
}

// The invitation, sent to somebody a manager has just added — or again, from
// their row, for as long as they have no PIN.
//
// Not uniform, unlike request_code: the caller here is not the anonymous
// public but a manager holding a register token and a PIN, and both RPCs
// check them (0087) before a phone number or a send is reached. Their
// refusals — already signed in, sent five times, sent a minute ago — are
// the manager's to read, so they are returned as they are. The outcome of
// the send is written back where the staff screen finds it, so "the SMS
// went" and "the SMS service refused" are told apart on the row.
async function sendInvite(body: Record<string, string>) {
  const auth = { p_register_token: body.register_token ?? "", p_pin: body.pin ?? "" };
  if (!auth.p_register_token || !auth.p_pin || !body.user_id) {
    return { status: 400, data: { ok: false, message: "Bad request" } };
  }
  const { data, error } = await supabase.rpc("pos_admin_invite_to_send", {
    ...auth,
    p_user_id: body.user_id,
  });
  if (error) return { status: 400, data: { ok: false, message: error.message } };
  const target = (data as { id: string; name: string; phone: string }[] | null)?.[0];
  if (!target) return { status: 400, data: { ok: false, message: "No such staff member" } };

  const message = inviteMessage(target.phone);
  const out = await sendSms(target.phone, message);
  const { error: recErr } = await supabase.rpc("pos_admin_invite_sms_outcome", {
    ...auth,
    p_user_id: target.id,
    p_error: out.sent ? null : out.reason,
  });
  if (recErr) console.error("invite outcome not recorded", recErr);
  return {
    status: 200,
    data: out.sent
      ? { ok: true, sent: true, reason: null, phone: target.phone, text: message }
      : { ok: true, sent: false, reason: out.reason, phone: target.phone, text: message },
  };
}

async function setPin(token: string, pin: string) {
  if (!/^\d{6}$/.test(pin)) {
    return { ok: false, message: "The PIN must be exactly 6 digits." };
  }
  const { data: permit } = await supabase
    .from("auth_setpin_tokens")
    .select("*")
    .eq("token", token)
    .eq("used", false)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!permit) {
    return { ok: false, message: "This link has expired. Start again with a new code." };
  }
  const { error } = await supabase.rpc("auth_set_pin", {
    p_phone: permit.phone_e164,
    p_pin: pin,
  });
  if (error) return { ok: false, message: error.message };
  await supabase.from("auth_setpin_tokens").update({ used: true }).eq("token", token);
  return { ok: true, message: "PIN set. You can sign in on your till now." };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request" }, 400);
  }

  try {
    switch (body.action) {
      case "request_code": {
        // Uniform in body AND in time: junk input, an unknown number and a
        // registered one all answer after the same floor.
        const started = Date.now();
        const phone = normalizePhone(body.phone ?? "");
        const reply = phone ? await requestCode(phone, body.purpose ?? "enrol") : UNIFORM;
        await floor(started, 600);
        return json(reply);
      }
      case "verify_code": {
        const phone = normalizePhone(body.phone ?? "");
        if (!phone || !body.code) return json({ ok: false, message: "That code didn't work." });
        return json(await verifyCode(phone, body.code));
      }
      case "set_pin":
        return json(await setPin(body.token ?? "", body.pin ?? ""));
      case "send_invite": {
        const r = await sendInvite(body);
        return json(r.data, r.status);
      }
      default:
        return json({ ok: false, message: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ ok: false, message: "Something went wrong. Try again." }, 500);
  }
});
