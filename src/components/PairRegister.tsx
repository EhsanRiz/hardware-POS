import { ENROL_URL, REQUEST_URL } from "../lib/config";
import { useState } from "react";
import { enrolDevice, pairRegister } from "../lib/api";
import { savePairing } from "../lib/device";
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
export default function PairRegister({ onPaired }: { onPaired: () => void }) {
  const [mode, setMode] = useState<"ask" | "till" | "phone">("ask");
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

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--color-bg)" }}>
      <div
        className="w-full max-w-sm rounded p-6 space-y-4"
        style={{ background: "var(--color-neutral-100)", border: "1px solid var(--divider)", boxShadow: "var(--shadow-md)" }}
      >
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
    // The front door of InnovaPOS. One address serves every shop, and it is
    // the pairing below, not the address, that decides which shop a device
    // belongs to — so this screen is what anybody sees who is not paired yet:
    // a manager with a new tablet, a colleague with their own phone, and a
    // stranger who typed the address. Each of them needs somewhere to go.
    return (
      <div className="firstrun">
        <div className="firstrun-head">
          <div className="sell-lockup">
            <InnovaMark size={30} onGreen />
            <span className="sell-wordmark" style={{ color: "var(--color-bg)" }}>
              Innova<span style={{ color: "var(--color-accent-400)" }}>POS</span>
            </span>
          </div>
          <h1 className="firstrun-title">The till for hardware shops</h1>
          <p className="firstrun-sub">
            This device is not set up for a shop yet. The shop is decided when
            a manager pairs it, so there is nothing to type in the address.
          </p>
        </div>
        <div className="firstrun-body">
          <h2 className="firstrun-ask">What is this device?</h2>
          <p className="firstrun-hint">
            A till takes money at the counter. A phone is your own, for the work
            away from it.
          </p>
          <button className="btn-tender" onClick={() => setMode("till")}>
            This is a till
          </button>
          <button className="btn-line w-full" onClick={() => setMode("phone")}>
            This is my phone
          </button>
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
        </div>
        <footer className="firstrun-foot">
          InnovaPOS · a product of InnovaEarth
          <br />© {new Date().getFullYear()} InnovaEarth · All rights reserved
        </footer>
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
        <button type="button" className="btn-line w-full"
          onClick={() => { setMode("ask"); setError(null); }}>
          Back
        </button>
      </form>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--color-bg)" }}>
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded p-6 space-y-4"
        style={{ background: "var(--color-neutral-100)", border: "1px solid var(--divider)", boxShadow: "var(--shadow-md)" }}
      >
        <div className="flex flex-col items-center gap-2 mb-2">
          <InnovaMark size={44} />
          <span className="sell-wordmark">
            Innova<span>POS</span>
          </span>
        </div>
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
        <button type="button" className="btn-line w-full"
          onClick={() => { setMode("ask"); setError(null); }}>
          Back
        </button>
      </form>
    </div>
  );
}
