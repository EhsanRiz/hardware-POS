import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useOnline } from "../lib/offline";
import { plainText } from "../lib/plaintext";
import { askTillAI, type TillAITurn } from "../lib/tillai";
import InnovaMark from "./InnovaMark";
import PinPad from "./PinPad";

/**
 * The rights that open Manage's reports, costs and cash-up. Somebody with
 * any of them can see more than the token-only tools show, so TillAI asks
 * for their PIN once and carries it to the same PIN-checked RPCs Manage
 * calls. Somebody with none of them is never asked: there is nothing a PIN
 * would open for them.
 */
const UNLOCKS = ["view_reports", "view_cost_prices", "manage_catalogue", "cash_management"];

/**
 * TillAI: the bubble in the corner, and the sheet it opens.
 *
 * A counter hand asks in plain words — "how much cement do we have", "when
 * did Mr Molefe last buy", "do we stock 2.5 twin and earth" — and gets an
 * answer from the shop's own records, with a line under it saying what was
 * looked at. It is an intelligent way in to what the till already shows;
 * it is not the till. It cannot ring up, void or change anything, it never
 * does sums with money, and anything behind Manage's PIN — reports, cost
 * prices, cash-up, the staff list, account balances — is not its to see.
 * The server decides all of that; this component only asks and shows.
 *
 * It needs the line, and it says so. The till sells without it: the bubble
 * is never in the path of a sale, and the scan field keeps its focus rules
 * when the sheet closes.
 *
 * A manager's questions go with the PIN they signed in with: with it,
 * TillAI can see what Manage shows them — takings for a period, cost
 * prices, stock value, who owes what — because the same PIN-checked RPCs
 * answer it. The PIN is the session's (AuthContext), held in memory only:
 * after a reload it is gone, and the sheet asks for it once and keeps it
 * for the rest of the sign-in. It is never stored, and the server never
 * logs it.
 *
 * On a phone (variant "phone") the bubble is the same bubble, in the same
 * corner; the sheet it opens takes the whole display, and the header's
 * chevron is the way back to it.
 *
 * Keyboard: F4 opens and closes it, Escape closes it, Enter sends.
 */
interface Message {
  role: "user" | "model";
  text: string;
  lookedAt?: string[];
  failed?: boolean;
}

export default function TillAI({
  variant = "bubble",
}: {
  variant?: "bubble" | "phone";
} = {}) {
  const phone = variant === "phone";
  const online = useOnline();
  const { user, sessionPin, setSessionPin } = useAuth();
  const canUnlock = (user?.permissions ?? []).some((p) => UNLOCKS.includes(p));
  // A counter hand's questions carry no credential at all: there is nothing
  // a PIN would open for them, so it stays out of the request.
  const pin = canUnlock ? sessionPin : null;
  const [pinStep, setPinStep] = useState<"ask" | "skipped">("ask");
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  // Asked only when there is something a PIN would open and the session
  // does not hold one yet: a counter hand is never asked, and a manager who
  // signed in a minute ago is not asked again.
  const askPin = canUnlock && pin === null && pinStep === "ask";
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F4") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy || !online) return;
    const history: TillAITurn[] = messages
      .filter((m) => !m.failed)
      .map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setBusy(true);
    try {
      const a = await askTillAI(question, history, pin);
      setMessages((m) => [...m, { role: "model", text: plainText(a.answer), lookedAt: a.lookedAt }]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "model", text: err instanceof Error ? err.message : "TillAI could not answer just now.", failed: true },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <>
      <button
        type="button"
        className={`tillai-bubble${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="TillAI"
        aria-expanded={open}
        title="TillAI (F4)"
      >
        <InnovaMark size={22} onGreen />
        <span>TillAI</span>
      </button>

      {open && (
        <section className={`tillai${phone ? " is-phone" : ""}`} role="dialog" aria-label="TillAI">
          <header className="tillai-head">
            {phone && (
              <button type="button" className="tillai-back" onClick={close} aria-label="Back">
                ‹
              </button>
            )}
            <InnovaMark size={22} onGreen />
            <span className="tillai-title">TillAI</span>
            <span className="tillai-sub">{pin ? "Unlocked · sees what you can" : "Ask about this shop"}</span>
            {!phone && (
              <button type="button" className="tillai-close" onClick={close} aria-label="Close TillAI">
                ✕
              </button>
            )}
          </header>

          {askPin ? (
            /* Once, on first open: the PIN that lets TillAI see what Manage
               shows this person. Skipping keeps the counter's view. */
            <div className="tillai-unlock">
              <p className="tillai-hint">
                Enter your PIN and TillAI can see what you can in Manage:
                takings, cost prices, stock value, who owes what. Skip it and
                it answers as it would for the counter.
              </p>
              <PinPad onSubmit={(p) => setSessionPin(p)} busy={false} />
              <button type="button" className="tillai-skip" onClick={() => setPinStep("skipped")}>
                Skip for now
              </button>
            </div>
          ) : (
          <div className="tillai-log">
            {messages.length === 0 && (
              <p className="tillai-hint">
                Ask in plain words: how much cement do we have, when did a
                customer last buy, do we stock 2.5 twin and earth. Answers come
                from this shop's own records. Cost prices, reports and cash-up
                stay in Manage.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`tillai-msg is-${m.role}${m.failed ? " is-failed" : ""}`}>
                <p>{m.text}</p>
                {m.lookedAt && m.lookedAt.length > 0 && (
                  <span className="tillai-looked">Looked at: {m.lookedAt.join(", ")}</span>
                )}
              </div>
            ))}
            {busy && <div className="tillai-msg is-model is-busy"><p>Looking…</p></div>}
            <div ref={endRef} />
          </div>
          )}

          {askPin ? null : online ? (
            <form className="tillai-ask" onSubmit={send}>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask TillAI…"
                aria-label="Ask TillAI"
                maxLength={500}
                disabled={busy}
              />
              <button type="submit" className="btn-line" disabled={busy || !input.trim()}>
                Ask
              </button>
            </form>
          ) : (
            /* No offline answer, and no pretending: the till keeps selling. */
            <p className="tillai-offline" role="status">
              TillAI needs the line. The till keeps selling without it.
            </p>
          )}
        </section>
      )}
    </>
  );
}
