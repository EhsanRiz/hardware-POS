/**
 * Which errors are worth telling the server about, and how to describe them.
 *
 * Pure, so Node can hold it to account (test/errors.test.mjs). The sending
 * is in errorReport.ts.
 *
 * Two kinds of noise are kept out. The line going down is not a bug: a
 * "Failed to fetch" at the counter is the shop's Wi-Fi, and the till already
 * handles it by queuing the sale. And the same error five hundred times is
 * one report, not five hundred: a message seen in the last five minutes is
 * not sent again.
 */

export interface ErrorReport {
  kind: string;
  message: string;
  stack: string | null;
  url: string;
  at: string;
}

export const REPEAT_WINDOW_MS = 5 * 60_000;
export const OUTBOX_MAX = 20;

/** Words and shape of an error that is the line, not the code. */
const THE_LINE = /failed to fetch|networkerror|load failed|network request failed|the operation was aborted|aborterror|err_internet_disconnected|err_network/i;

export function describe(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: `${err.name}: ${err.message}`.slice(0, 500), stack: err.stack?.slice(0, 4000) ?? null };
  }
  if (typeof err === "string") return { message: err.slice(0, 500), stack: null };
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; name?: unknown; code?: unknown };
    const parts = [o.name, o.code, o.message].filter((x) => typeof x === "string" && x) as string[];
    if (parts.length) return { message: parts.join(": ").slice(0, 500), stack: null };
    try {
      return { message: JSON.stringify(err).slice(0, 500), stack: null };
    } catch {
      /* fall through */
    }
  }
  return { message: String(err).slice(0, 500), stack: null };
}

export function isTheLine(message: string): boolean {
  return THE_LINE.test(message);
}

/**
 * Whether to send this one. `seen` maps a message to when it was last sent;
 * it is updated when the answer is yes.
 */
export function worthSending(message: string, seen: Map<string, number>, now: number): boolean {
  if (!message.trim()) return false;
  if (isTheLine(message)) return false;
  const last = seen.get(message);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return false;
  seen.set(message, now);
  return true;
}

/** Add to the outbox, keeping the newest OUTBOX_MAX. */
export function enqueue(outbox: ErrorReport[], report: ErrorReport): ErrorReport[] {
  return [...outbox, report].slice(-OUTBOX_MAX);
}
