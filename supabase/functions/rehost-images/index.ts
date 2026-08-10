// One-time: download product images that still point at an external CDN and
// re-host them in our own product-images bucket, then update image_url.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async () => {
  const { data: products, error } = await supabase
    .from("products")
    .select("id,image_url")
    .like("image_url", "%amazonaws.com%");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  let ok = 0, failed = 0;
  for (const p of products ?? []) {
    try {
      const resp = await fetch(p.image_url as string, { redirect: "follow" });
      if (!resp.ok) { failed++; continue; }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const path = `menu/${p.id}.jpg`;
      const up = await supabase.storage.from("product-images").upload(path, bytes, {
        contentType: resp.headers.get("content-type") || "image/jpeg",
        upsert: true,
      });
      if (up.error) { failed++; continue; }
      const { data: pub } = supabase.storage.from("product-images").getPublicUrl(path);
      await supabase.from("products").update({ image_url: pub.publicUrl }).eq("id", p.id);
      ok++;
    } catch (_e) { failed++; }
  }
  return new Response(JSON.stringify({ total: (products ?? []).length, ok, failed }), {
    headers: { "content-type": "application/json" },
  });
});
