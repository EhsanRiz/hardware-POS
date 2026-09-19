import type { QuoteLine } from "./api";

/**
 * What a till remembers about quotes between visits.
 *
 * The list and the lines are kept on the device so the counter reads them off
 * the disk while the line is fetching a fresh copy — and reads them at all
 * when there is no line. The rules live here rather than in the screen for the
 * same reason judge() lives in offline.ts: a bound that is only exercised
 * through a browser is a bound nobody checks.
 *
 * WHAT THIS CACHE MAY NOT BE USED FOR. A quote is a promise at a price, and
 * the list says which promises are still open. A row off the disk can be wrong
 * in the one direction that matters — a quote somebody else has since
 * converted or cancelled still reads "open" — so it is for READING only.
 * Recalling, cancelling, emailing and building a PDF all go to the server,
 * which is what decides whether the quote is still there to act on.
 */

/** The last list of open quotes this till was given. */
export const LIST_KEY = "quotes.list";
/** Quote lines, by quote id. */
export const ITEMS_KEY = "quotes.items";

/**
 * How many quotes' lines to keep.
 *
 * localStorage is small and shared with the catalogue, the customers, the
 * queues and the roster, so this cannot grow by one entry per quote anybody
 * has ever opened. Forty is comfortably more than a counter works through in
 * a day and far short of a quota problem.
 */
export const ITEMS_KEPT = 40;

export type ItemsCache = Record<string, QuoteLine[]>;

/** The lines last seen for a quote, or null if this device has never read it. */
export function cachedLines(cache: ItemsCache, id: string): QuoteLine[] | null {
  return cache[id] ?? null;
}

/**
 * Remember a quote's lines, keeping the cache bounded.
 *
 * Insertion order is the record of what was read most recently: the entry is
 * deleted before it is re-added, so re-reading a quote moves it to the end
 * rather than leaving it near the chop, and the oldest go first.
 */
export function rememberLines(
  cache: ItemsCache,
  id: string,
  lines: QuoteLine[]
): ItemsCache {
  const { [id]: _dropped, ...rest } = cache;
  const next: ItemsCache = { ...rest, [id]: lines };
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - ITEMS_KEPT))) {
    delete next[old];
  }
  return next;
}
