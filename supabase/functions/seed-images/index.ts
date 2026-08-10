// One-time seeder: downloads a relevant photo for each product that has none
// and stores it in the public `product-images` bucket, then sets image_url.
// Runs on Supabase's network (which has internet), so it works even when the
// developer's environment cannot reach the web. Idempotent: skips products
// that already have an image. Safe to re-run.
//
// Deploy:  supabase functions deploy seed-images --no-verify-jwt
// Trigger: POST https://<ref>.supabase.co/functions/v1/seed-images
//          (or via pg_net from SQL — see supabase/migrations notes).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CATEGORY_KW: Record<string, string> = {
  Coffee: "coffee",
  Cold: "coffee",
  Cakes: "cake",
  Pastry: "pastry",
  Food: "food",
};

function keywordsFor(name: string, category: string): string {
  const words = name.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/)
    .slice(0, 2).join(",");
  const cat = CATEGORY_KW[category] ?? "food";
  return `${words},${cat}`;
}

Deno.serve(async () => {
  const { data: products, error } = await supabase
    .from("products")
    .select("id,name,category,image_url");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const results: unknown[] = [];
  for (const p of products ?? []) {
    if (p.image_url) {
      results.push({ name: p.name, skipped: true });
      continue;
    }
    try {
      const kw = keywordsFor(p.name, p.category);
      const src = `https://loremflickr.com/400/300/${encodeURIComponent(kw)}`;
      const resp = await fetch(src, { redirect: "follow" });
      if (!resp.ok) {
        results.push({ name: p.name, ok: false, status: resp.status });
        continue;
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const path = `seed/${p.id}.jpg`;
      const up = await supabase.storage.from("product-images").upload(
        path,
        bytes,
        { contentType: "image/jpeg", upsert: true },
      );
      if (up.error) {
        results.push({ name: p.name, ok: false, err: up.error.message });
        continue;
      }
      const { data: pub } = supabase.storage.from("product-images")
        .getPublicUrl(path);
      await supabase.from("products").update({ image_url: pub.publicUrl }).eq(
        "id",
        p.id,
      );
      results.push({ name: p.name, ok: true });
    } catch (e) {
      results.push({ name: p.name, ok: false, err: String(e) });
    }
  }

  return new Response(JSON.stringify({ count: results.length, results }), {
    headers: { "content-type": "application/json" },
  });
});
