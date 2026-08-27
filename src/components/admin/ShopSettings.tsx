import { useEffect, useRef, useState } from "react";
import { adminSaveSettings, type ShopDetails } from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { refreshSettings, shopSettings } from "../../lib/settings";

/** The text fields only — the one boolean is edited by its own control. */
type TextKey = {
  [K in keyof ShopDetails]: ShopDetails[K] extends string ? K : never;
}[keyof ShopDetails];

interface Field {
  key: TextKey;
  label: string;
  hint?: string;
  inputMode?: "tel" | "numeric";
}

const FIELDS: Field[] = [
  { key: "shop_name", label: "Shop name" },
  { key: "address_line1", label: "Street address" },
  { key: "address_line2", label: "Town & province" },
  { key: "phone", label: "Phone", inputMode: "tel" },
  { key: "email", label: "Email", hint: "Where customers ask for a copy of an invoice." },
  {
    key: "vat_number",
    label: "VAT number",
    hint: "Printed on every invoice. Without it the slip is not a valid tax invoice.",
  },
  { key: "registration_number", label: "Company registration number" },
  { key: "currency", label: "Currency symbol" },
];

// Where the money goes. Kept as its own card rather than seven more boxes
// under the address: these are only read by somebody about to pay, and they
// have their own failure — a wrong digit here is an invoice nobody can settle.
const BANK_FIELDS: Field[] = [
  { key: "bank_name", label: "Bank" },
  {
    key: "bank_account_name",
    label: "Account name",
    hint: "The name the account is held in, which is not always the trading name.",
  },
  { key: "bank_account_number", label: "Account number", inputMode: "numeric" },
  { key: "bank_branch_code", label: "Branch code", inputMode: "numeric" },
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
  const [f, setF] = useState<ShopDetails>(() => toDetails(shopSettings()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Read-only, and served rather than compiled in — see the note beside it.
  const [vat, setVat] = useState<number | null>(() => shopSettings().vat_rate ?? null);

  // The cache is what the till prints from; the server is what is true. Take
  // the server's version on the way in so an edit is never made against a
  // figure that has since changed on another till.
  //
  // But only if nothing has been typed yet. The fetch lands whenever the line
  // lets it, and a manager who starts typing straight away would otherwise have
  // the answer arrive on top of their edit and wipe it — silently, since the
  // field simply goes back to what it was and Save then writes the old value.
  // Fast connections hide this completely; a slow one loses the change.
  const touched = useRef(false);
  useEffect(() => {
    void refreshSettings().then((server) => {
      if (!touched.current) setF(toDetails(server));
      setVat(server.vat_rate ?? null);
    });
  }, []);

  function set(k: TextKey, v: string) {
    touched.current = true;
    setF((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }

  function setQuotePrices(v: boolean) {
    touched.current = true;
    setF((prev) => ({ ...prev, quote_show_line_prices: v }));
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

        {/* Not editable, and worth saying why rather than leaving a greyed box
            to look broken. What is CHARGED has never been a build constant —
            every sale line resolves the rate on the day and stores it, so a
            reprint restates what was actually charged. The rate itself is a
            national fact shared by every shop on this system, so a box here
            would quietly change other people's invoices. */}
        <div className="pt-1">
          <span className="text-sm text-stone-600">VAT rate</span>
          <p className="mt-1 text-lg tabular-nums">
            {vat == null ? "—" : `${+(vat * 100).toFixed(2)}%`}
          </p>
          <span className="text-xs text-stone-500">
            Set nationally, not per shop, and applied by date — old invoices keep
            the rate they were charged at. Ask us to change it when SARS does.
          </span>
        </div>

      </div>

      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4 mt-4">
        <div>
          <h2 className="font-medium">Banking details</h2>
          {/* The till takes EFT and the slip said nothing about where to pay,
              so an EFT customer had to phone the shop before they could settle
              — which is how an invoice becomes an old invoice. */}
          <p className="text-sm text-stone-500">
            Printed on any invoice that leaves with the money still owed — EFT
            and account sales. Leave blank and those slips say nothing about
            where to pay.
          </p>
        </div>

        {BANK_FIELDS.map((field) => (
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

      </div>

      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4 mt-4">
        <div>
          <h2 className="font-medium">Quotes</h2>
          {/* A quote is a piece of paper that leaves the shop and gets read by
              people who are not the customer. Itemised, it is a shopping list:
              the cement gets matched down the road and the customer comes back
              for the two lines nobody else stocks, or does not come back. */}
          <p className="text-sm text-stone-500">
            What a printed quote shows. This never affects an invoice — a tax
            invoice has to itemise, which is SARS's rule and not a preference.
          </p>
        </div>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 accent-stone-800"
            checked={f.quote_show_line_prices}
            onChange={(e) => setQuotePrices(e.target.checked)}
            aria-label="Show a price against each line on a quote"
          />
          <span>
            <span className="block text-sm text-stone-700">
              Show a price against each line
            </span>
            <span className="block text-xs text-stone-500">
              {f.quote_show_line_prices
                ? "Every item is priced, then the total."
                : "The quote lists what is included and gives one total. What each item costs stays in the shop."}
            </span>
          </span>
        </label>
      </div>

      {/* One Save for the page, not one per card. Every card edits the same
          record and a single save writes all of it, so repeated buttons would
          only raise the question of which one this field belongs to. */}
      <div className="max-w-xl flex items-center gap-3 mt-4">
        <button
          className="px-4 py-2 rounded-lg bg-colophon text-paper disabled:opacity-40"
          disabled={busy || !f.shop_name.trim()}
          onClick={save}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}

/**
 * The cached settings, as the form's own shape.
 *
 * ShopSettings carries what the till reads — including the served VAT rate,
 * which is not editable — and the form edits strings. Nulls become empty boxes
 * rather than the word "null" in an input.
 */
function toDetails(s: ReturnType<typeof shopSettings>): ShopDetails {
  return {
    shop_name: s.shop_name,
    address_line1: s.address_line1,
    address_line2: s.address_line2,
    phone: s.phone,
    vat_number: s.vat_number,
    currency: s.currency,
    registration_number: s.registration_number,
    email: s.email ?? "",
    bank_name: s.bank_name ?? "",
    bank_account_name: s.bank_account_name ?? "",
    bank_account_number: s.bank_account_number ?? "",
    bank_branch_code: s.bank_branch_code ?? "",
    quote_show_line_prices: s.quote_show_line_prices !== false,
  };
}
