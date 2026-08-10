import { useState } from "react";
import type { User } from "../lib/types";
import { updateProfile } from "../lib/api";
import { formatPhone } from "../lib/format";

interface Props {
  user: User;
  onClose: () => void;
  onUpdated: (u: Partial<User>) => void;
}

export default function Profile({ user, onClose, onUpdated }: Props) {
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [newPin, setNewPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (currentPin.trim() === "") {
      setError("Enter your current PIN to save changes");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProfile(currentPin.trim(), {
        name: name.trim(),
        phone: phone.trim() === "" ? null : phone.trim(),
        email: email.trim() === "" ? null : email.trim(),
        newPin: newPin.trim() === "" ? null : newPin.trim(),
      });
      onUpdated({ name: updated.name, phone: updated.phone, email: updated.email });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm animate-scale-in max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-stone-800 mb-1">My profile</h2>
        <p className="text-taupe text-sm mb-4 capitalize">{user.role}</p>

        <label className="block text-sm font-medium text-stone-600 mb-1">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
        />

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">Phone</label>
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              placeholder="5012 3456"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Email <span className="text-taupe-light">(optional)</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              placeholder="name@email.com"
            />
          </div>
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">
          New PIN <span className="text-taupe-light">(leave blank to keep)</span>
        </label>
        <input
          type="tel"
          inputMode="numeric"
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
          maxLength={6}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 tracking-widest focus:border-brand outline-none"
          placeholder="••••"
        />

        <div className="bg-stone-50 rounded-lg p-3 mb-4">
          <label className="block text-sm font-medium text-stone-600 mb-1">
            Current PIN <span className="text-red-500">*</span>
          </label>
          <input
            type="tel"
            inputMode="numeric"
            value={currentPin}
            onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
            maxLength={6}
            className="w-full h-12 px-3 rounded-lg border border-stone-300 tracking-widest focus:border-brand outline-none"
            placeholder="Confirm to save"
          />
        </div>

        {error && <p className="text-red-600 text-sm mb-3 animate-fade-in">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || name.trim() === ""}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
