import { registerToken } from "./device";
import { cacheGet, cacheSet } from "./localCache";
import { supabase } from "./supabase";
import { describe, enqueue, worthSending, type ErrorReport } from "./errorRules";

/**
 * The till tells the server what went wrong.
 *
 * A render crash, an uncaught error, an unhandled rejection: each becomes
 * one small report — kind, message, stack, the screen's address — sent
 * through the token-only RPC pos_report_error. It waits for the line if
 * there is none (the outbox lives in local storage, newest twenty) and
 * goes when the line comes back, because "no line" is exactly when things
 * go wrong at a counter.
 *
 * Nothing here can break the till: every step is wrapped, a report that
 * cannot be sent is dropped, and an unpaired device sends nothing at all.
 * What is worth sending is decided in errorRules.ts, which is pure.
 */

const OUTBOX_KEY = "errors.outbox";
export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "dev";

const seen = new Map<string, number>();
let flushing = false;

export function reportError(kind: string, err: unknown): void {
  try {
    const { message, stack } = describe(err);
    if (!worthSending(message, seen, Date.now())) return;
    const report: ErrorReport = {
      kind,
      message,
      stack,
      url: typeof location !== "undefined" ? location.pathname + location.search : "",
      at: new Date().toISOString(),
    };
    cacheSet(OUTBOX_KEY, enqueue(cacheGet<ErrorReport[]>(OUTBOX_KEY, []), report));
    void flush();
  } catch {
    /* reporting must never be a second error */
  }
}

async function flush(): Promise<void> {
  if (flushing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const token = registerToken();
  if (!token) return;
  flushing = true;
  try {
    let outbox = cacheGet<ErrorReport[]>(OUTBOX_KEY, []);
    while (outbox.length > 0) {
      const r = outbox[0];
      const { error } = await supabase.rpc("pos_report_error", {
        p_register_token: token,
        p_kind: r.kind,
        p_message: r.message,
        p_stack: r.stack,
        p_url: r.url,
        p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 300) : null,
        p_version: APP_VERSION,
      });
      // A refusal (revoked till, bad request) is not worth retrying; a
      // dropped line is, and the next 'online' will.
      if (error && /fetch|network|abort/i.test(String(error.message ?? ""))) break;
      outbox = outbox.slice(1);
      cacheSet(OUTBOX_KEY, outbox);
    }
  } catch {
    /* next time */
  } finally {
    flushing = false;
  }
}

/** Once, at boot: the browser's own error events, and the outbox on reconnect. */
export function installErrorReporting(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    // A failed image or script load is an Event with no message; only a
    // thrown error carries one.
    if (!(e instanceof ErrorEvent) || (!e.error && !e.message)) return;
    reportError("error", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError("rejection", e.reason);
  });
  window.addEventListener("online", () => void flush());
  void flush();
}
