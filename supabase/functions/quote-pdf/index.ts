// The quotation as it was sent, kept and handed back.
//
// A quote's figures are already frozen in quote_items, so rebuilding gives the
// same prices forever. What is not frozen is the paper around them — address,
// telephone, terms, logo — so the file itself is stored the moment the quote is
// saved, and every later download hands back THAT file rather than today's
// rendering of it.
//
// The bucket is private: a quotation carries a customer's name and what they
// were quoted. Reading comes back through here, which signs a URL good for ten
// minutes.
//
// Write once. `put` asks the database where the document is before it uploads
// anything, and does nothing if there already is one — pos_quote_set_pdf keeps
// the same rule on its side, so neither a repeat tap nor a second till can
// replace the page the customer is holding.
//
// Actions:
//   put  { register_token, quote_id, file }  → { ok, path, stored }
//   get  { register_token, quote_id }        → { ok, url } | { ok, url: null }
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BUCKET = "sale-documents";
const MAX_BYTES = 5 * 1024 * 1024;
const SIGNED_FOR_SECONDS = 600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  let b: Record<string, string>;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request" }, 400);
  }

  const token = b.register_token ?? "";
  const quoteId = b.quote_id ?? "";
  const action = b.action ?? "put";
  // No PIN: a till that can create a quote can keep its document. The register
  // token is the credential, and it is the same one pos_save_quote took.
  if (!token || !quoteId) return json({ ok: false, message: "Missing details" }, 400);

  // Where the document is, if it is anywhere. This also proves the quote is
  // this register's shop — the function raises otherwise.
  const { data: existing, error: lookupError } = await supabase.rpc("pos_quote_pdf", {
    p_register_token: token,
    p_quote_id: quoteId,
  });
  if (lookupError) {
    return json({ ok: false, message: lookupError.message }, 403);
  }

  if (action === "get") {
    if (!existing) return json({ ok: true, url: null });
    const { data: signed, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(existing as string, SIGNED_FOR_SECONDS);
    if (error || !signed) {
      console.error(error);
      return json({ ok: false, message: "Could not open that document" }, 500);
    }
    return json({ ok: true, url: signed.signedUrl });
  }

  // Already kept: say so and touch nothing.
  if (existing) return json({ ok: true, path: existing, stored: false });

  const match = /^data:application\/pdf;base64,(.+)$/s.exec(b.file ?? "");
  if (!match) return json({ ok: false, message: "Unreadable document" }, 400);
  let bytes: Uint8Array;
  try {
    const binary = atob(match[1]);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return json({ ok: false, message: "Unreadable document" }, 400);
  }
  if (bytes.length > MAX_BYTES) {
    return json({ ok: false, message: "That document is too large" }, 413);
  }

  // Named for the quote, so a repeat cannot scatter copies; upsert is off so
  // an existing object is never quietly rewritten.
  const { data: orgRow } = await supabase
    .from("quotes")
    .select("org_id")
    .eq("id", quoteId)
    .maybeSingle();
  if (!orgRow) return json({ ok: false, message: "Unknown quote" }, 404);
  const path = `${orgRow.org_id}/quotes/${quoteId}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    console.error(uploadError);
    return json({ ok: false, message: "Could not keep that document" }, 500);
  }

  const { data: kept, error: recordError } = await supabase.rpc("pos_quote_set_pdf", {
    p_register_token: token,
    p_quote_id: quoteId,
    p_path: path,
  });
  if (recordError) {
    console.error(recordError);
    return json({ ok: false, message: recordError.message }, 400);
  }
  return json({ ok: true, path: kept, stored: true });
});
