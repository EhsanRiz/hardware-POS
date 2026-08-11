import { useState } from "react";
import { pairRegister } from "../lib/api";
import { savePairing } from "../lib/device";
import InnovaMark from "./InnovaMark";
import { errorMessage } from "../lib/errors";

/**
 * First-run screen: pair this tablet as a till.
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
      savePairing(register_id, token, name);
      onPaired();
    } catch (err) {
      // supabase-js errors are plain objects, so instanceof Error misses them
      // and the real reason — a refused method, a wrong PIN, a blocked
      // request — would be replaced by a generic line that helps nobody.
      setError(errorMessage(err, "Pairing failed — check the phone number and PIN."));
      setBusy(false);
    }
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
      </form>
    </div>
  );
}
