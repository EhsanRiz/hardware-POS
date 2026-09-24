// Photographs of stock, taken on the tablet at the shelf.
//
// Uploading runs here rather than from the browser for one reason: the browser
// holds only the anon key, and a storage bucket writable with the anon key is a
// bucket anyone on the internet can fill. This function holds the service role,
// and it will not touch storage until it has proved — with the till's register
// token and the manager's PIN — that the caller may manage this shop's
// catalogue. Same credential pair as every other privileged action.
//
// The order matters: CHECK, then upload, then record. A permission failure
// after the upload would leave an orphaned file nobody can see or delete.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BUCKET = "product-images";
/** Generous for a downscaled photo; the client sends ~150 KB. */
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  let b: Record<string, string>;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request" }, 400);
  }

  // A counter's phone on a count job (0115). No till, no PIN: the count token
  // is the credential, and it opens exactly one thing — a photo on one of
  // that phone's own captures, filed under that count.
  if (b.count_token) return await countPhoto(b);

  const token = b.register_token ?? "";
  const pin = b.pin ?? "";
  const productId = b.product_id ?? "";
  const dataUrl = b.image ?? "";

  if (!token || !pin || !productId || !dataUrl) {
    return json({ ok: false, message: "Missing details" }, 400);
  }

  // 1. May this till, with this PIN, photograph this shop's catalogue? Either
  //    right will do: shelf_capture is the grant made for exactly this job
  //    (0044), manage_catalogue is the broader power that contains it. The org
  //    it returns also becomes the storage prefix, so one shop's photographs
  //    can never land under another's.
  let orgId: string | null = null;
  let permMessage: string | undefined;
  for (const perm of ["shelf_capture", "manage_catalogue"]) {
    const { data, error } = await supabase.rpc("pos_admin_org_for", {
      p_register_token: token,
      p_pin: pin,
      p_perm: perm,
    });
    if (!error && data) {
      orgId = data;
      break;
    }
    permMessage = error?.message;
  }
  if (!orgId) {
    return json({ ok: false, message: permMessage ?? "Not permitted" }, 403);
  }

  // 2. Decode. data:image/jpeg;base64,AAAA…
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return json({ ok: false, message: "Unreadable image" }, 400);
  const [, mime, b64] = match;
  const ext = TYPES[mime];
  if (!ext) return json({ ok: false, message: "Use a JPEG, PNG or WebP" }, 400);

  let bytes: Uint8Array;
  try {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return json({ ok: false, message: "Unreadable image" }, 400);
  }
  if (bytes.length > MAX_BYTES) {
    return json({ ok: false, message: "That photo is too large" }, 413);
  }

  // 3. Upload. The path carries the org so the bucket stays legible, and a
  //    random name so re-uploading never overwrites an earlier photo.
  const path = `${orgId}/${productId}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    console.error(uploadError);
    return json({ ok: false, message: "Could not store that photo" }, 500);
  }

  // 4. Record it. This RPC re-checks the PIN — the check above was to avoid an
  //    orphaned file, not to replace the real authorisation.
  const { data: imageId, error: linkError } = await supabase.rpc(
    "pos_admin_add_product_image",
    {
      p_register_token: token,
      p_pin: pin,
      p_product_id: productId,
      p_url: path,
      p_sort_order: Number(b.sort_order ?? 0),
    },
  );
  if (linkError) {
    // Roll the file back rather than leaving it behind.
    await supabase.storage.from(BUCKET).remove([path]);
    return json({ ok: false, message: linkError.message }, 400);
  }

  return json({ ok: true, id: imageId, path });
});

/** data:image/jpeg;base64,… → bytes and extension, or a refusal. */
function decode(dataUrl: string):
  | { ok: true; bytes: Uint8Array; mime: string; ext: string }
  | { ok: false; status: number; message: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return { ok: false, status: 400, message: "Unreadable image" };
  const [, mime, b64] = match;
  const ext = TYPES[mime];
  if (!ext) return { ok: false, status: 400, message: "Use a JPEG, PNG or WebP" };
  let bytes: Uint8Array;
  try {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return { ok: false, status: 400, message: "Unreadable image" };
  }
  if (bytes.length > MAX_BYTES) {
    return { ok: false, status: 413, message: "That photo is too large" };
  }
  return { ok: true, bytes, mime, ext };
}

// A photo from a counter's phone. Same order as above — check, upload, record
// — and idempotent: the phone sends again whenever it is not sure the last
// try landed, so a photo the count already holds uploads nothing.
async function countPhoto(b: Record<string, string>): Promise<Response> {
  const token = b.count_token ?? "";
  const captureRef = b.capture_ref ?? "";
  const photoRef = b.photo_ref ?? "";
  if (!captureRef || !photoRef || !b.image) {
    return json({ ok: false, message: "Missing details" }, 400);
  }

  const { data: rows, error: checkError } = await supabase.rpc("pos_count_photo_check", {
    p_token: token, p_capture_ref: captureRef, p_photo_ref: photoRef,
  });
  if (checkError) return json({ ok: false, message: checkError.message }, 403);
  const target = (rows as { org_id: string; job_id: string; existing_path: string | null }[])[0];
  if (!target) return json({ ok: false, message: "Not permitted" }, 403);
  if (target.existing_path) return json({ ok: true, path: target.existing_path });

  const img = decode(b.image);
  if (!img.ok) return json({ ok: false, message: img.message }, img.status);

  const path = `${target.org_id}/count/${target.job_id}/${crypto.randomUUID()}.${img.ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, img.bytes, { contentType: img.mime, upsert: false });
  if (uploadError) {
    console.error(uploadError);
    return json({ ok: false, message: "Could not store that photo" }, 500);
  }

  const { data: stored, error: linkError } = await supabase.rpc("pos_count_add_photo", {
    p_token: token, p_capture_ref: captureRef, p_photo_ref: photoRef, p_path: path,
  });
  if (linkError) {
    await supabase.storage.from(BUCKET).remove([path]);
    return json({ ok: false, message: linkError.message }, 400);
  }
  // Two tries racing each other: the first one recorded is the one kept.
  if (stored !== path) await supabase.storage.from(BUCKET).remove([path]);
  return json({ ok: true, path: stored });
}
