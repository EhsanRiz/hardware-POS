/**
 * Reading errors that did not come from `throw new Error(...)`.
 *
 * supabase-js does not throw: it returns `{ data, error }`, and api.ts turns a
 * non-null `error` into `throw error`. That error is a plain object, so every
 * `e instanceof Error` check in the codebase silently misses it. Two things
 * went wrong because of that, and both are fixed by going through here:
 *
 *   - A connectivity failure was not recognised as one, so a sale taken at the
 *     moment the line dropped was rejected outright instead of queued.
 *   - The reason a sale was refused ("Not enough stock for X") was replaced
 *     with a generic message, leaving the cashier with no idea what to do.
 */

/**
 * What a dead line says. supabase-js does not throw on a failed fetch: it
 * returns an error whose message is the stringified TypeError, so the
 * Manage gate with the line down read "TypeError: Failed to fetch" — a
 * sentence about the browser, to somebody who wanted to know whether to try
 * again. These are the browsers' own words for the same thing; each becomes
 * the one line below. offline.ts still reads the raw text, to decide.
 */
const DEAD_LINE_RE =
  /failed to fetch|networkerror|network request failed|load failed|err_internet_disconnected|network error/i;
export const NO_LINE = "No connection to the server. Try again when the line is back.";

/** A human-readable message from anything that was thrown. */
export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  const raw = rawErrorMessage(e, fallback);
  return DEAD_LINE_RE.test(raw) ? NO_LINE : raw;
}

/** The message as thrown, before a dead line is put into plain words. */
export function rawErrorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const msg =
      (o.message as string) ||
      (o.details as string) ||
      (o.hint as string) ||
      (o.error_description as string) ||
      (o.error as string) ||
      (o.code ? `Error ${o.code}` : "");
    if (msg) return String(msg);
  }
  return fallback;
}

/** The error's `name`, for shapes that carry one without being an Error. */
export function errorName(e: unknown): string {
  if (e instanceof Error) return e.name;
  if (e && typeof e === "object") return String((e as { name?: unknown }).name ?? "");
  return "";
}
