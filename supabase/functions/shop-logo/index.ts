// The shop's logo, for the documents that leave the building.
//
// Same shape and the same reason as product-image: the browser holds only the
// anon key, and a bucket writable with the anon key is a bucket anyone on the
// internet can fill. This function holds the service role and will not touch
// storage until it has proved, with the till's token and a PIN, that the
// caller may manage this shop's settings.
//
// It shares the product-images bucket, which is already public — a logo is
// meant to be seen — and writes under <org>/logo/ so the bucket stays legible.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BUCKET = "product-images";
/** A logo is a small file. Anything bigger is a photograph by mistake. */
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

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
  const dataUrl = b.image ?? "";
  if (!token || !pin || !dataUrl) {
    return json({ ok: false, message: "Missing details" }, 400);
  }

  // 1. May this till, with this PIN, change this shop's settings?
  const { data: orgId, error: permError } = await supabase.rpc("pos_admin_org_for", {
    p_register_token: token,
    p_pin: pin,
    p_perm: "manage_settings",
  });
  if (permError || !orgId) {
    return json({ ok: false, message: permError?.message ?? "Not permitted" }, 403);
  }

  // 2. Decode.
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return json({ ok: false, message: "Unreadable image" }, 400);
  const [, mime, b64] = match;
  const ext = TYPES[mime];
  if (!ext) return json({ ok: false, message: "Use a PNG, JPEG, WebP or SVG" }, 400);

  let bytes: Uint8Array;
  try {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return json({ ok: false, message: "Unreadable image" }, 400);
  }
  if (bytes.length > MAX_BYTES) {
    return json({ ok: false, message: "That logo is too large (2 MB at most)" }, 413);
  }

  // 3. Upload. A random name, so replacing a logo never has to wait for a
  //    cache to notice and never overwrites the one still on screen.
  const path = `${orgId}/logo/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    console.error(uploadError);
    return json({ ok: false, message: "Could not store that logo" }, 500);
  }

  // 4. Record it, through the ordinary settings RPC — which checks the PIN
  //    again. The check above was to avoid an orphaned file, not to replace
  //    the real authorisation.
  const { error: saveError } = await supabase.rpc("pos_admin_save_settings", {
    p_register_token: token,
    p_pin: pin,
    p_settings: { logo_url: path },
  });
  if (saveError) {
    await supabase.storage.from(BUCKET).remove([path]);
    return json({ ok: false, message: saveError.message }, 400);
  }
  return json({ ok: true, path });
});
