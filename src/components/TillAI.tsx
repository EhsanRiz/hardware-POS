import { useEffect, useRef, useState } from "react";
import { useOnline } from "../lib/offline";
import { askTillAI, type TillAITurn } from "../lib/tillai";
import InnovaMark from "./InnovaMark";

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
 * Keyboard: F4 opens and closes it, Escape closes it, Enter sends.
 */
interface Message {
  role: "user" | "model";
  text: string;
  lookedAt?: string[];
  failed?: boolean;
}

export default function TillAI() {
  const online = useOnline();
  const [open, setOpen] = useState(false);
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
        setOpen(false);
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
      const a = await askTillAI(question, history);
      setMessages((m) => [...m, { role: "model", text: a.answer, lookedAt: a.lookedAt }]);
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
        <section className="tillai" role="dialog" aria-label="TillAI">
          <header className="tillai-head">
            <InnovaMark size={22} onGreen />
            <span className="tillai-title">TillAI</span>
            <span className="tillai-sub">Ask about this shop</span>
            <button type="button" className="tillai-close" onClick={() => setOpen(false)} aria-label="Close TillAI">
              ✕
            </button>
          </header>

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

          {online ? (
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
