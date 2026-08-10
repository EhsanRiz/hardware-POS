// The "request InnovaPOS" form on pos.innovaearth.com.
//
// Stores the enquiry and emails it to InnovaEarth via Resend. Public endpoint
// (a prospect has no credentials by definition), so it is rate-limited per
// email address and validates just enough to keep junk out of the inbox.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const NOTIFY_TO = Deno.env.get("POS_REQUEST_TO") ?? "ehsan@innovaearth.com";
// Until innovaearth.com is verified in Resend, its sandbox sender still
// delivers to the account owner's own address — which is exactly NOTIFY_TO.
const NOTIFY_FROM = Deno.env.get("RESEND_FROM") ?? "InnovaPOS <onboarding@resend.dev>";

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

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  let b: Record<string, string>;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request" }, 400);
  }

  const orgName = (b.org_name ?? "").trim().slice(0, 200);
  const contact = (b.contact_name ?? "").trim().slice(0, 200);
  const email = (b.email ?? "").trim().slice(0, 200);
  const phone = (b.phone ?? "").trim().slice(0, 40);
  const country = (b.country ?? "").trim().slice(0, 60);
  const vertical = ["hardware", "hospitality", "other"].includes(b.vertical) ? b.vertical : "hardware";
  const message = (b.message ?? "").trim().slice(0, 2000);

  if (!orgName || !contact || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, message: "Please fill in the business name, your name and a valid email." }, 400);
  }

  // Three enquiries an hour per address is plenty for a human, and a wall for
  // a script aimed at the inbox.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await supabase
    .from("pos_requests")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .gte("created_at", hourAgo);
  if ((count ?? 0) >= 3) {
    return json({ ok: true, message: "Thank you — we already have your enquiry and will be in touch." });
  }

  const { error } = await supabase.from("pos_requests").insert({
    org_name: orgName, contact_name: contact, email, phone, country, vertical, message,
  });
  if (error) {
    console.error(error);
    return json({ ok: false, message: "Something went wrong. Please try again." }, 500);
  }

  // The email is best-effort: the enquiry is already stored, so a Resend blip
  // must not turn a captured lead into a user-facing failure.
  const key = Deno.env.get("RESEND_API_KEY");
  if (key) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [NOTIFY_TO],
        reply_to: email,
        subject: `InnovaPOS request — ${orgName}`,
        html: `<h2>New InnovaPOS request</h2>
<table cellpadding="6">
<tr><td><b>Business</b></td><td>${esc(orgName)}</td></tr>
<tr><td><b>Contact</b></td><td>${esc(contact)}</td></tr>
<tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
<tr><td><b>Phone</b></td><td>${esc(phone) || "—"}</td></tr>
<tr><td><b>Country</b></td><td>${esc(country) || "—"}</td></tr>
<tr><td><b>Vertical</b></td><td>${esc(vertical)}</td></tr>
<tr><td><b>Message</b></td><td>${esc(message) || "—"}</td></tr>
</table>
<p>Create the org in Supabase → SQL editor:</p>
<pre>select innova_create_org('${esc(orgName).replace(/'/g, "''")}', '${esc(contact).replace(/'/g, "''")}', '+27…manager phone…');</pre>
<p>The manager then enrols at pos.innovaearth.com → Store sign-in → First time here.</p>`,
      }),
    });
    if (!res.ok) console.error("Resend", res.status, await res.text());
  } else {
    console.error("RESEND_API_KEY missing; enquiry stored but not emailed");
  }

  return json({ ok: true, message: "Thank you — we will be in touch within one working day." });
});
