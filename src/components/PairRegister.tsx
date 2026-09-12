import { ENROL_URL, REQUEST_URL } from "../lib/config";
import { useEffect, useState } from "react";
import { enrolDevice, pairRegister } from "../lib/api";
import { savePairing } from "../lib/device";
import { useOnline } from "../lib/offline";
import { todayLine } from "../lib/today";
import LoginEngraving from "./LoginEngraving";
import InnovaMark from "./InnovaMark";
import { errorMessage } from "../lib/errors";

/**
 * First-run screen: what is this device?
 *
 * Two answers, and they are not the same thing (0074). A TILL is the counter
 * screen: a manager pairs it with their phone number and PIN, it takes money,
 * and anybody on the staff can sign in on it. A PHONE belongs to one person,
 * is enrolled with a one-time code issued against their name in Manage ->
 * Staff, and cannot take money at all. Asking somebody enrolling their own
 * phone for the manager's PIN is how staff learn to watch the master PIN
 * being typed, which is why the two paths are separate from the very first
 * screen.
 *
 * A manager does this once, with their phone number and PIN. The phone is
 * needed here and only here: it is the one moment the server does not yet know
 * which shop this device belongs to, and the phone — globally unique across
 * all of InnovaPOS — answers that. The server returns a random token which is
 * stored on the device and never shown again — it is what lets a sale taken
 * during an outage sync later without anyone's PIN. If the tablet is lost, the
 * token is revoked from Settings on another device; nobody's PIN has to change.
 */
/* The two paths, drawn as the engraving draws things: single strokes. */
function TillIcon() {
  return (
    <svg className="firstrun-path-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="9" width="36" height="24" rx="3" />
      <line x1="6" y1="28" x2="42" y2="28" />
      <path d="M 18 33 l -3 7 h 18 l -3 -7" />
      <line x1="10" y1="40" x2="38" y2="40" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg className="firstrun-path-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="15" y="5" width="18" height="38" rx="4" />
      <line x1="21" y1="9" x2="27" y2="9" />
      <circle cx="24" cy="38" r="1.6" />
    </svg>
  );
}

export default function PairRegister({ onPaired }: { onPaired: () => void }) {
  const [mode, setMode] = useState<"ask" | "till" | "phone">("ask");
  const online = useOnline();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("Front Counter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { register_id, token } = await pairRegister(phone, pin, name);
      savePairing(register_id, token, name, "till");
      onPaired();
    } catch (err) {
      // supabase-js errors are plain objects, so instanceof Error misses them
      // and the real reason — a refused method, a wrong PIN, a blocked
      // request — would be replaced by a generic line that helps nobody.
      setError(errorMessage(err, "Pairing failed — check the phone number and PIN."));
      setBusy(false);
    }
  }

  async function enrol(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await enrolDevice(code, name);
      savePairing(r.register_id, r.token, name, "personal");
      onPaired();
    } catch (err) {
      setError(errorMessage(err, "That code is not valid. Ask for a new one."));
      setBusy(false);
    }
  }

  // The way back to "What is this device?" from either form. It is a quiet
  // link in the card's top corner, not a second button under the gold one:
  // a form with one action should look like it has one action, and the way
  // out belongs where people look for it. Escape does the same.
  const back = () => {
    if (busy) return;
    setMode("ask");
    setError(null);
  };
  useEffect(() => {
    if (mode === "ask") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, busy]);

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--color-bg)" }}>
      <div
        className="pair-card w-full max-w-sm rounded p-6 space-y-4"
        style={{ background: "var(--color-neutral-100)", border: "1px solid var(--divider)", boxShadow: "var(--shadow-md)" }}
      >
        <button type="button" className="pair-back" onClick={back} disabled={busy}>
          <span aria-hidden="true">‹</span> Back
        </button>
        <div className="flex flex-col items-center gap-2 mb-2">
          <InnovaMark size={44} />
          <span className="sell-wordmark">
            Innova<span>POS</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );

  if (mode === "ask") {
    // The front door of InnovaPOS, on the same two panels as sign-in so a
    // device that has just been paired does not seem to change product. One
    // address serves every shop, and it is the pairing below, not the
    // address, that decides which shop a device belongs to — so this is what
    // anybody sees who is not paired yet: a manager with a new tablet, a
    // colleague with their own phone, and a stranger who typed the address.
    // Each of them needs somewhere to go.
    return (
      <div className="login firstrun">
        <div className="login-scene">
          <img className="login-photo" src="/door.jpg" alt="" decoding="async" />
          <div className="login-head">
            <div className="sell-lockup">
              <InnovaMark size={30} onGreen />
              <span className="sell-wordmark" style={{ color: "var(--color-bg)" }}>
                Innova<span style={{ color: "var(--color-accent-400)" }}>POS</span>
              </span>
            </div>
            <h1 className="firstrun-title">Most tills just wait. This one listens.</h1>
            <ul className="firstrun-proof">
              <li>Sells with the line down</li>
              <li>SARS-compliant invoices</li>
              <li>Scan, bill, take payment, print</li>
            </ul>
          </div>

          <LoginEngraving />

          <dl className="login-status">
            <div>
              <dt>Today</dt>
              <dd>{todayLine()}</dd>
            </div>
            <div>
              <dt>Line</dt>
              <dd className={online ? "" : "is-offline"}>{online ? "Online" : "Offline"}</dd>
            </div>
          </dl>
        </div>

        <div className="login-body">
          <h2 className="firstrun-ask">What is this device?</h2>
          <p className="firstrun-hint">
            This device is not set up for a shop yet. The shop is decided when
            a manager pairs it, so there is nothing to type in the address.
          </p>
          <div className="firstrun-paths">
            <button className="firstrun-path" onClick={() => setMode("till")}>
              <TillIcon />
              <span className="firstrun-path-text">
                <span className="firstrun-path-name">This is a till</span>
                <span className="firstrun-path-desc">
                  Takes money at the counter. A manager pairs it once with
                  their phone number and PIN.
                </span>
              </span>
            </button>
            <button className="firstrun-path" onClick={() => setMode("phone")}>
              <PhoneIcon />
              <span className="firstrun-path-text">
                <span className="firstrun-path-name">This is my phone</span>
                <span className="firstrun-path-desc">
                  Your own, for the work away from the counter. Set up with a
                  code from whoever manages staff.
                </span>
              </span>
            </button>
          </div>
          <div className="firstrun-outs">
            <p>
              Invited to a shop but no PIN yet?{" "}
              <a href={ENROL_URL} target="_blank" rel="noreferrer">Set your PIN</a>
            </p>
            <p>
              Not on InnovaPOS yet?{" "}
              <a href={REQUEST_URL} target="_blank" rel="noreferrer">Request it for your shop</a>
            </p>
          </div>
          <footer className="login-foot">
            <p>
              InnovaPOS · a product of InnovaEarth
              <br />© {new Date().getFullYear()} InnovaEarth · All rights reserved
            </p>
          </footer>
        </div>
      </div>
    );
  }

  if (mode === "phone") {
    return shell(
      <form onSubmit={enrol} className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-center">Put your phone on the shop</h1>
          <p className="text-sm text-center mt-1"
            style={{ color: "var(--color-neutral-700)" }}>
            Ask whoever manages staff for a code. It lasts fifteen minutes and
            works once.
          </p>
        </div>
        <label className="block">
          <span className="kicker">Your code</span>
          <input
            autoFocus
            autoCapitalize="characters"
            autoComplete="one-time-code"
            placeholder="ABCD2345"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="modal-input mt-1 text-center text-2xl tracking-[0.25em]"
          />
        </label>
        <label className="block">
          <span className="kicker">Name this phone</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sam's phone"
            className="modal-input mt-1"
          />
        </label>
        {error && <p className="text-sm" style={{ color: "var(--color-owing)" }}>{error}</p>}
        <button disabled={busy || code.trim().length < 8} className="btn-tender">
          {busy ? "Setting up…" : "Set up my phone"}
        </button>
      </form>
    );
  }

  return shell(
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-center">Set up this till</h1>
          <p className="text-sm text-center mt-1"
            style={{ color: "var(--color-neutral-700)" }}>
            A manager needs to pair this device once before it can sell.
          </p>
        </div>

        <label className="block">
          <span className="kicker">Name this till</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="modal-input mt-1"
          />
        </label>

        <label className="block">
          <span className="kicker">Manager phone number</span>
          <input
            autoFocus
            type="tel"
            inputMode="tel"
            placeholder="082 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="modal-input mt-1"
          />
        </label>

        <label className="block">
          <span className="kicker">Manager PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="modal-input mt-1 text-center text-2xl tracking-[0.4em]"
          />
        </label>

        {error && <p className="text-sm" style={{ color: "var(--color-owing)" }}>{error}</p>}

        <button
          disabled={busy || pin.length < 4 || phone.trim().length < 8}
          className="btn-tender"
        >
          {busy ? "Pairing…" : "Pair this till"}
        </button>
      </form>
  );
}
