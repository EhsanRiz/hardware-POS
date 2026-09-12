/**
 * The Approve link in the "new InnovaPOS request" email.
 *
 * A GET with the request's token. It asks the database to approve the
 * request (innova_approve_request, 0080: make the shop, invite the manager,
 * mark the request done), shows InnovaEarth a plain page saying what
 * happened, and emails the person who asked that their shop is ready and
 * how their manager enrols. A second click on the same link says the shop
 * was already set up and makes nothing.
 *
 * No key is needed to open it — it is a link in an email — which is why
 * the token is 24 random bytes and the function holds the service role
 * only for this one call.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const FROM = Deno.env.get("RESEND_FROM") ?? "InnovaPOS <till@innovaearth.com>";
const ENROL_URL = "https://pos.innovaearth.com/enrol/";
const TILL_URL = "https://till.innovaearth.com/";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{margin:0;background:#f5f2ea;color:#1b2a24;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:8vh auto;padding:28px;background:#faf8f1;border:1px solid #d9d3c3;border-radius:10px}
h1{font-size:22px;margin:0 0 12px}code{background:#efe9d8;padding:2px 6px;border-radius:4px}
p{margin:10px 0}.k{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8a5f14;font-weight:600}</style>
<main><p class="k">InnovaPOS</p><h1>${esc(title)}</h1>${body}</main>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return page("Not that way", "<p>Open the Approve link from the email.</p>", 405);
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{48}$/.test(token)) return page("Not a link we sent", "<p>The approve link is incomplete or has been altered.</p>", 404);

  const { data, error } = await supabase.rpc("innova_approve_request", { p_token: token });
  if (error) {
    console.error(error);
    return page("Something went wrong", `<p>${esc(error.message)}</p><p>Nothing was created. Try again in a moment, or create the shop by hand.</p>`, 500);
  }
  const r = data as {
    ok: boolean; already?: boolean; reason?: string; message?: string;
    org_id?: string; org_name?: string; manager_name?: string; manager_phone?: string; email?: string;
  };

  if (!r.ok) {
    return page("Not set up", `<p>${esc(r.message)}</p>`, r.reason === "unknown" ? 404 : 409);
  }
  if (r.already) {
    return page(`${r.org_name} is already set up`, `<p>${esc(r.message)}</p><p>Manager: <code>${esc(r.manager_phone)}</code>.</p>`);
  }

  // Tell the person who asked. Best effort: the shop exists whatever Resend says.
  const key = Deno.env.get("RESEND_API_KEY");
  let told = false;
  if (key && r.email) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: FROM,
        to: [r.email],
        subject: `${r.org_name} is ready on InnovaPOS`,
        html: `<p>Hello ${esc(r.manager_name)},</p>
<p><b>${esc(r.org_name)}</b> is set up on InnovaPOS, and you are its manager.</p>
<p>Three steps, on the phone whose number you gave us (${esc(r.manager_phone)}):</p>
<ol>
<li>Open <a href="${ENROL_URL}">${ENROL_URL}</a>, enter that number, and type in the code we SMS you.</li>
<li>Choose your PIN.</li>
<li>On the till, open <a href="${TILL_URL}">${TILL_URL}</a>, choose <b>This is a till</b>, and pair it with your number and PIN.</li>
</ol>
<p>Then add your staff from Manage → Staff, and load your products from Manage → Bulk import.</p>
<p>Reply to this email if anything is unclear.<br>InnovaEarth</p>`,
      }),
    });
    told = res.ok;
    if (!res.ok) console.error("Resend", res.status, await res.text());
  }

  return page(`${r.org_name} is set up`, `
<p>The shop exists and <b>${esc(r.manager_name)}</b> is invited as its manager on <code>${esc(r.manager_phone)}</code>.</p>
<p>${told ? `They have been emailed at <code>${esc(r.email)}</code> with how to enrol and pair a till.` : `The email to <code>${esc(r.email)}</code> could not be sent; tell them to enrol at ${esc(ENROL_URL)} with that number.`}</p>
<p>Shop id: <code>${esc(r.org_id)}</code></p>`);
});
