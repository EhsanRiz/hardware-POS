// Supplier documents: the pages of a quotation, invoice or delivery note,
// photographed on the phone or uploaded as the PDF the supplier emailed.
//
// Same shape as product-image, for the same reason: the browser holds only
// the anon key, so it hands the file and the manager's PIN to this function,
// which proves the right (manage_purchasing) with the service role before it
// touches storage. Unlike product photographs the bucket is PRIVATE — a
// supplier's prices are the shop's cost base — so reading a page also comes
// through here: `sign` checks the PIN and hands back URLs good for ten
// minutes.
//
// Actions:
//   page  { register_token, pin, document_id, file }  → { ok, page_no, path }
//   sign  { register_token, pin, document_id }        → { ok, pages: [{page_no, mime, url}] }
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BUCKET = "supplier-documents";
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
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
  const pin = b.pin ?? "";
  const documentId = b.document_id ?? "";
  const action = b.action ?? "page";
  if (!token || !pin || !documentId) {
    return json({ ok: false, message: "Missing details" }, 400);
  }

  // 1. May this till, with this PIN, file this shop's supplier paperwork?
  const { data: orgId, error: permError } = await supabase.rpc("pos_admin_org_for", {
    p_register_token: token,
    p_pin: pin,
    p_perm: "manage_purchasing",
  });
  if (permError || !orgId) {
    return json({ ok: false, message: permError?.message ?? "Not permitted" }, 403);
  }
  // …and is this document the shop's? The RPCs below check again; this is
  // to avoid an orphaned file in the bucket, not to replace them.
  const { data: doc } = await supabase
    .from("supplier_documents")
    .select("id")
    .eq("id", documentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!doc) return json({ ok: false, message: "Document not found" }, 404);

  if (action === "sign") {
    const { data: pages, error } = await supabase.rpc("pos_purchasing_document_pages", {
      p_register_token: token,
      p_pin: pin,
      p_document_id: documentId,
    });
    if (error) return json({ ok: false, message: error.message }, 400);
    const rows = (pages ?? []) as { page_no: number; path: string; mime: string }[];
    if (rows.length === 0) return json({ ok: true, pages: [] });
    const { data: signed, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(rows.map((r) => r.path), SIGNED_FOR_SECONDS);
    if (signError || !signed) {
      console.error(signError);
      return json({ ok: false, message: "Could not open the pages" }, 500);
    }
    return json({
      ok: true,
      pages: rows.map((r, i) => ({ page_no: r.page_no, mime: r.mime, url: signed[i]?.signedUrl ?? null })),
    });
  }

  // 2. Decode the page. data:image/jpeg;base64,… or data:application/pdf;base64,…
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(b.file ?? "");
  if (!match) return json({ ok: false, message: "Unreadable file" }, 400);
  const [, mime, b64] = match;
  const ext = TYPES[mime];
  if (!ext) return json({ ok: false, message: "Use a photo (JPEG, PNG, WebP) or a PDF" }, 400);

  let bytes: Uint8Array;
  try {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return json({ ok: false, message: "Unreadable file" }, 400);
  }
  if (bytes.length > MAX_BYTES) {
    return json({ ok: false, message: "That file is too large (10 MB at most)" }, 413);
  }

  // 3. Upload, under the org and the document, with a name that cannot clash.
  const path = `${orgId}/${documentId}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    console.error(uploadError);
    return json({ ok: false, message: "Could not store that page" }, 500);
  }

  // 4. Record it as the next page. Re-checks the PIN.
  const { data: pageNo, error: linkError } = await supabase.rpc("pos_purchasing_add_page", {
    p_register_token: token,
    p_pin: pin,
    p_document_id: documentId,
    p_path: path,
    p_mime: mime,
  });
  if (linkError) {
    await supabase.storage.from(BUCKET).remove([path]);
    return json({ ok: false, message: linkError.message }, 400);
  }
  return json({ ok: true, page_no: pageNo, path });
});
