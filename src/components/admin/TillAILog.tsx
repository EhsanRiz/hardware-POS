import { useEffect, useState } from "react";
import { tillaiQuestions, type TillAIQuestion } from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { fmtDayMonthTime } from "../../lib/dates";

/**
 * What the shop asked TillAI.
 *
 * Every question, newest first, with the answer it got and what was looked
 * at. Two things a manager reads it for: what their staff reach for the
 * assistant to find out, and what it could not answer — the second is the
 * list of what the till should do next. Behind view_reports, as takings are.
 */
export default function TillAILog({ pin }: { pin: string }) {
  const [rows, setRows] = useState<TillAIQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    tillaiQuestions(pin).then(
      (r) => { if (live) setRows(r); },
      (e) => { if (live) setError(errorMessage(e, "Could not load TillAI's log.")); }
    );
    return () => { live = false; };
  }, [pin]);

  const today = rows?.filter((r) => Date.now() - Date.parse(r.asked_at) < 86_400_000).length ?? 0;

  return (
    <section className="tillai-log-page">
      <header className="tillai-log-head">
        <h2>TillAI</h2>
        <p className="acc-note">
          What this shop asked TillAI, newest first, and what it looked at to
          answer. A question it could not answer is a thing the till does not
          do yet.
        </p>
        {rows && (
          <p className="tillai-log-count">
            {rows.length === 0 ? "Nothing asked yet." : `${today} in the last day · ${rows.length} kept`}
          </p>
        )}
      </header>

      {error && <p className="login-error" role="alert">{error}</p>}
      {!rows && !error && <p className="acc-note">Loading…</p>}

      {rows && rows.length > 0 && (
        <ol className="tillai-log-list">
          {rows.map((r) => (
            <li key={r.id} className={`tillai-log-row${open === r.id ? " is-open" : ""}`}>
              <button type="button" className="tillai-log-q" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <span className="tillai-log-when">
                  {fmtDayMonthTime(r.asked_at)} · {r.register_name}
                  {r.unlocked && <span className="tillai-log-unlocked"> · unlocked</span>}
                </span>
                <span className="tillai-log-text">{r.question}</span>
              </button>
              {open === r.id && (
                <div className="tillai-log-a">
                  <p>{r.answer ?? "No answer was kept."}</p>
                  {r.tools.length > 0 && (
                    <span className="tillai-looked">Looked at: {r.tools.join(", ")}</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
