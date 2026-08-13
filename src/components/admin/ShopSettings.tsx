import { useEffect, useState } from "react";
import { adminSaveSettings, type ShopDetails } from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { refreshSettings, shopSettings } from "../../lib/settings";

const FIELDS: {
  key: keyof ShopDetails;
  label: string;
  hint?: string;
  inputMode?: "tel" | "numeric";
}[] = [
  { key: "shop_name", label: "Shop name" },
  { key: "address_line1", label: "Street address" },
  { key: "address_line2", label: "Town & province" },
  { key: "phone", label: "Phone", inputMode: "tel" },
  {
    key: "vat_number",
    label: "VAT number",
    hint: "Printed on every invoice. Without it the slip is not a valid tax invoice.",
  },
  { key: "registration_number", label: "Company registration number" },
  { key: "currency", label: "Currency symbol" },
];

/**
 * The shop's own details.
 *
 * These are the invoice header, which is why they live in the database and not
 * in a build: a shop that registers for VAT on a Tuesday should not need a
 * redeploy to issue a valid tax invoice on the Wednesday. Saving refreshes the
 * device cache too, because that cache is what prints during an outage — leave
 * it stale and the next power cut prints the old address.
 */
export default function ShopSettings({ pin }: { pin: string }) {
  const [f, setF] = useState<ShopDetails>(() => shopSettings());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The cache is what the till prints from; the server is what is true. Take
  // the server's version on the way in so an edit is never made against a
  // figure that has since changed on another till.
  useEffect(() => {
    void refreshSettings().then(setF);
  }, []);

  function set(k: keyof ShopDetails, v: string) {
    setF((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminSaveSettings(pin, { ...f });
      await refreshSettings();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e, "Could not save the shop details"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4">
        <div>
          <h2 className="font-medium">Shop details</h2>
          <p className="text-sm text-stone-500">
            These print at the top of every invoice and quote.
          </p>
        </div>

        {error && (
          <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">{error}</p>
        )}

        {FIELDS.map((field) => (
          <label key={field.key} className="block">
            <span className="text-sm text-stone-600">{field.label}</span>
            <input
              className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
              value={f[field.key] ?? ""}
              inputMode={field.inputMode}
              onChange={(e) => set(field.key, e.target.value)}
              aria-label={field.label}
            />
            {field.hint && <span className="text-xs text-stone-500">{field.hint}</span>}
          </label>
        ))}

        <div className="flex items-center gap-3 pt-1">
          <button
            className="px-4 py-2 rounded-lg bg-stone-800 text-white disabled:opacity-40"
            disabled={busy || !f.shop_name.trim()}
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-sm text-emerald-700">Saved.</span>}
        </div>
      </div>
    </div>
  );
}
