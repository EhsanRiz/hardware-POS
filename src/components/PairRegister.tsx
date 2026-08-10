import { useState } from "react";
import { pairRegister } from "../lib/api";
import { savePairing } from "../lib/device";
import ShopLogo from "./ShopLogo";

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
      setError(
        err instanceof Error
          ? err.message
          : "Pairing failed — check the phone number and PIN."
      );
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-stone-50">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-6 space-y-4"
      >
        <div className="flex justify-center mb-2">
          <ShopLogo className="h-16 w-auto" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-center">Set up this till</h1>
          <p className="text-sm text-stone-500 text-center mt-1">
            A manager needs to pair this device once before it can sell.
          </p>
        </div>

        <label className="block">
          <span className="text-sm text-stone-600">Name this till</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-stone-600">Manager phone number</span>
          <input
            autoFocus
            type="tel"
            inputMode="tel"
            placeholder="082 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-stone-600">Manager PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2
                       text-center text-2xl tracking-[0.4em]"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          disabled={busy || pin.length < 4 || phone.trim().length < 8}
          className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold
                     disabled:opacity-40"
        >
          {busy ? "Pairing…" : "Pair this till"}
        </button>
      </form>
    </div>
  );
}
