// Product lookup on the device.
//
// This mirrors `normalize_search_text` and `pos_search_products` from migrations
// 0010–0012. The duplication is deliberate: the till has to keep selling through
// an outage, and a search that only works online fails at exactly the moment the
// shop needs it. Server-side search is better — it sees the whole catalogue and
// uses real trigram indexes — so it is preferred when the network is up, and
// this takes over when it is not.
//
// Keep the two in step. If the normalisation rules change in SQL, change them
// here too, or the same query will behave differently online and offline.
import type { Product } from "./types";

/**
 * Canonical form for both product text and typed queries.
 *
 * Hardware sizes are written every possible way — 2.5x50, 2,5 x 50, 2.5X50mm,
 * 2.5*50 — and a counter hand will use whichever is quickest. Normalising both
 * sides to one form is what lets "2.5x5" reach "2.5 x 50mm".
 */
export function normalizeSearchText(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2") // decimal comma -> point
    .replace(/(\d)\s*[x*×]\s*(\d)/g, "$1 x $2") // dimension separators
    .replace(/(\d)(mm|cm|m|kg|g|l|ml)\b/g, "$1 $2") // split unit suffixes
    .replace(/[^a-z0-9. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTextFor(p: Product): string {
  return normalizeSearchText(
    [p.name, p.sku, p.description ?? "", p.barcode ?? ""].join(" ")
  );
}

/** Levenshtein distance, capped — we only care about small edit distances. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, curr[j]);
    }
    if (best > max) return max + 1; // whole row already too far
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Search the cached catalogue.
 *
 * Two passes, matching the server: an exact-ish pass first, and an
 * edit-distance pass only if that found nothing. Trigram-style matching alone
 * collapses on a transposition in a short word ("nial" for "nail"), which is a
 * very common typo at a busy counter.
 */
export function searchProductsLocal(
  products: Product[],
  query: string,
  limit = 25
): Product[] {
  const norm = normalizeSearchText(query);
  if (!norm) return products.slice(0, limit);

  const tokens = norm.split(" ").filter((t) => t && t !== "x");
  if (tokens.length === 0) return products.slice(0, limit);

  const raw = query.trim();
  const scored: { p: Product; score: number }[] = [];

  for (const p of products) {
    const text = searchTextFor(p);
    // Every token must be accounted for: "concrete nail" should not return
    // every nail in the shop.
    if (!tokens.every((t) => text.includes(t))) continue;

    let score = 0;
    if (p.barcode && p.barcode === raw) score += 100;
    else if (p.sku.toLowerCase() === raw.toLowerCase()) score += 90;
    if (text.includes(norm)) score += 5;
    // Prefer the shorter name for an equally good match.
    score += 1 / (1 + p.name.length / 40);
    scored.push({ p, score });
  }

  if (scored.length === 0) {
    // Forgiving pass: compare each typed word to each word of the product text.
    for (const p of products) {
      const words = searchTextFor(p).split(" ").filter(Boolean);
      const ok = tokens.every((t) =>
        words.some((w) => editDistance(t, w, t.length < 4 ? 1 : 2) <= (t.length < 4 ? 1 : 2))
      );
      if (ok) scored.push({ p, score: 1 / (1 + p.name.length / 40) });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((s) => s.p);
}

/**
 * An exact code match, for the scan path.
 *
 * A barcode scanner is a keyboard that types fast and presses Enter, so a scan
 * arrives here as a submitted query. An unambiguous code should ring straight
 * through rather than presenting a list of one.
 */
export function exactMatch(products: Product[], query: string): Product | null {
  const raw = query.trim();
  if (!raw) return null;
  return (
    products.find((p) => p.barcode && p.barcode === raw) ??
    products.find((p) => p.sku.toLowerCase() === raw.toLowerCase()) ??
    null
  );
}
