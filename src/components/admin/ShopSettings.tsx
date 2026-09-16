import { useEffect, useRef, useState } from "react";
import {
  adminSaveSettings, fetchBankAccounts, saveBankAccounts, setDeliveryCost,
  uploadShopLogo, type EditableBankAccount, type ShopDetails,
} from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { downscaleImage, imageSrc } from "../../lib/images";
import { refreshSettings, shopSettings } from "../../lib/settings";
import { getPrintMode, setPrintMode, type PrintMode } from "../../lib/print";
import {
  publishSlipMetrics, setSlipWidth, slipWidth, SLIP_WIDTHS, type SlipWidth,
} from "../../lib/config";

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

// Where the money goes. Its own card rather than four more boxes under the
// address: these are only read by somebody about to pay, and they have their
// own failure — a wrong digit here is an invoice nobody can settle.
//
// Repeated per account since 0103. A shop banks in more than one place and it
// matters to the customer which: an EFT within a bank clears the same day,
// between banks it does not.
interface BankField {
  key: keyof Omit<EditableBankAccount, "on_documents">;
  label: string;
  hint?: string;
  inputMode?: "numeric";
}

const BANK_FIELDS: BankField[] = [
  { key: "bank_name", label: "Bank" },
  {
    key: "account_name",
    label: "Account name",
    hint: "The name the account is held in, which is not always the trading name.",
  },
  { key: "account_number", label: "Account number", inputMode: "numeric" },
  { key: "branch_code", label: "Branch code", inputMode: "numeric" },
];

const EMPTY_ACCOUNT: EditableBankAccount = {
  bank_name: "", account_name: "", account_number: "", branch_code: "",
  on_documents: true,
};

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
  // Per-device, so it is read from the device rather than the shop record.
  const [printMode, setPrintModeState] = useState<PrintMode>(getPrintMode);
  const [cols, setCols] = useState<number>(slipWidth);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * The shop's accounts, read separately because the till is never given all
   * of them — an account kept off documents exists only here.
   *
   * `banksLoaded` is not presentation. Saving sends the list WHOLE, so an
   * empty list is an instruction to delete every account the shop has — and
   * this starts empty. Until the read has come back there is nothing safe to
   * send, so nothing is sent and nothing is offered to edit.
   */
  const [banks, setBanks] = useState<EditableBankAccount[]>([]);
  const [banksLoaded, setBanksLoaded] = useState(false);
  // Read-only, and served rather than compiled in — see the note beside it.
  const [vat, setVat] = useState<number | null>(() => shopSettings().vat_rate ?? null);
  /**
   * What a trip costs the shop. Saved on its own like the logo, and for the
   * same reason: it goes through a different door — it is the cost of the
   * delivery line in the catalogue, not a field on the shop.
   */
  const [delCost, setDelCost] = useState(() => {
    const c = shopSettings().delivery_cost;
    return c == null ? "" : String(c);
  });
  const [delBusy, setDelBusy] = useState(false);
  const [delSaved, setDelSaved] = useState(false);

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
      if (!touched.current) {
        setDelCost(server.delivery_cost == null ? "" : String(server.delivery_cost));
      }
    });
  }, []);

  /**
   * The accounts, behind the same PIN that opened this screen.
   *
   * Not part of the settings the till caches: a till is only ever given the
   * accounts meant for documents, and the one a shop keeps to itself has to
   * be asked for by somebody who may change the settings. Held to the same
   * rule as the fetch above — an answer that lands after somebody has started
   * typing is not allowed to wipe what they typed.
   */
  const banksTouched = useRef(false);
  useEffect(() => {
    void fetchBankAccounts(pin)
      .then((rows) => {
        // Its own flag, not the page's. Somebody who starts typing their new
        // phone number the instant the screen opens has not touched the
        // ACCOUNTS, and treating that as "leave them alone" left the list
        // empty — which Save would then have written, deleting every account
        // the shop had. The two edits are independent and are tracked apart.
        if (!banksTouched.current) setBanks(rows);
        setBanksLoaded(true);
      })
      .catch((e) => setError(errorMessage(e, "Could not read the bank accounts")));
  }, [pin]);

  function set(k: TextKey, v: string) {
    touched.current = true;
    setF((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }

  const logoRef = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);

  /**
   * The shop's mark. Saved on its own the moment it is chosen rather than
   * waiting for Save: it goes through a different door (an edge function, not
   * the settings RPC), and a manager who uploads a logo and then presses
   * Cancel has still uploaded a logo. Better that the screen agrees with what
   * happened.
   */
  async function pickLogo(file: File | null | undefined) {
    if (!file) return;
    setLogoBusy(true);
    setError(null);
    try {
      // A logo is printed a few centimetres wide, so it is shrunk: a 4 MB
      // photograph of one helps nobody. SVG is not taken — the bucket is
      // public and served under the till's own origin, and an SVG is a
      // document that can carry script, so one uploaded by anybody with the
      // settings right would have run on every till in the shop.
      if (file.type === "image/svg+xml") {
        throw new Error("Use a PNG, JPEG or WebP for the logo, not an SVG.");
      }
      const data = await downscaleImage(file, 800, 0.92);
      const path = await uploadShopLogo(pin, data);
      setF((prev) => ({ ...prev, logo_url: path }));
      await refreshSettings();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e, "The logo could not be uploaded"));
    } finally {
      setLogoBusy(false);
      if (logoRef.current) logoRef.current.value = "";
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    setError(null);
    try {
      await adminSaveSettings(pin, { logo_url: "" });
      setF((prev) => ({ ...prev, logo_url: "" }));
      await refreshSettings();
    } catch (e) {
      setError(errorMessage(e, "The logo could not be removed"));
    } finally {
      setLogoBusy(false);
    }
  }

  function setQuotePrices(v: boolean) {
    touched.current = true;
    setF((prev) => ({ ...prev, quote_show_line_prices: v }));
    setSaved(false);
  }

  function setBank(i: number, patch: Partial<EditableBankAccount>) {
    banksTouched.current = true;
    setBanks((prev) => prev.map((b, n) => (n === i ? { ...b, ...patch } : b)));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminSaveSettings(pin, { ...f });
      // The accounts go with the same press. Two calls, because they are two
      // records — but one button, because a manager correcting a branch code
      // and a phone number in one visit should press Save once.
      //
      // Only once they have been read. The list is sent whole, so sending the
      // empty one this screen starts with would delete every account the shop
      // has — and a read that failed or has not landed is not a shop with no
      // accounts.
      if (banksLoaded) {
        await saveBankAccounts(pin, banks);
        setBanks(await fetchBankAccounts(pin));
      }
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
          {/* Why more than one is worth the trouble: a payment inside a bank
              lands the same day, between banks it takes two — so a customer
              who can see their own bank pays the shop sooner. */}
          <p className="text-sm text-stone-500">
            List more than one and a customer can pay into their own bank,
            which clears the same day instead of in two.
          </p>
        </div>

        {!banksLoaded && (
          <p className="text-sm text-stone-500">Reading the shop's accounts…</p>
        )}

        {banksLoaded && banks.length === 0 && (
          <p className="text-sm text-stone-500">
            No account yet — invoices leave without saying where to pay.
          </p>
        )}

        {banksLoaded && banks.map((bank, i) => (
          <div key={i} className="rounded-lg border border-stone-200 p-4 space-y-3">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium text-stone-800">
                {bank.bank_name.trim() || `Account ${i + 1}`}
              </h3>
              <button
                type="button"
                className="ml-auto text-sm text-stone-600 underline"
                aria-label={`Remove account ${i + 1}`}
                onClick={() => {
                  banksTouched.current = true;
                  setBanks((prev) => prev.filter((_, n) => n !== i));
                  setSaved(false);
                }}
              >
                Remove
              </button>
            </div>

            {BANK_FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="text-sm text-stone-600">{field.label}</span>
                <input
                  className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
                  value={bank[field.key]}
                  inputMode={field.inputMode}
                  onChange={(e) => setBank(i, { [field.key]: e.target.value })}
                  aria-label={`${field.label} ${i + 1}`}
                />
                {field.hint && <span className="text-xs text-stone-500">{field.hint}</span>}
              </label>
            ))}

            {/* The account a shop keeps to itself. Switched off it stays here
                and is never sent to a till, so it cannot be printed by
                accident on somebody's invoice. */}
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={bank.on_documents}
                aria-label={`Show account ${i + 1} on invoices and quotes`}
                onChange={(e) => setBank(i, { on_documents: e.target.checked })}
              />
              <span className="text-sm text-stone-700">
                Show on invoices and quotes
                <span className="block text-xs text-stone-500">
                  Off for an account the shop keeps to itself — it stays here
                  and never reaches a till.
                </span>
              </span>
            </label>
          </div>
        ))}

        <button
          type="button"
          className="px-3 py-2 rounded-lg border border-stone-300 text-sm"
          disabled={!banksLoaded}
          onClick={() => {
            banksTouched.current = true;
            setBanks((prev) => [...prev, { ...EMPTY_ACCOUNT }]);
            setSaved(false);
          }}
        >
          Add another account
        </button>
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

      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4 mt-4">
        <div>
          <h2 className="font-medium">What a delivery costs</h2>
          <p className="text-sm text-stone-500">
            Fuel there and back, plus what the driver's hour is worth. Without
            it every delivery reports as pure profit, which it is not — and
            somebody will price against that figure. One number per trip; change
            it when the diesel price moves.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="block flex-1">
            <span className="text-sm text-stone-600">Cost per delivery</span>
            <input
              className="modal-input"
              inputMode="decimal"
              value={delCost}
              placeholder="0.00"
              aria-label="Cost per delivery"
              onChange={(e) => {
                touched.current = true;
                setDelCost(e.target.value);
                setDelSaved(false);
              }}
            />
          </label>
          <button
            type="button"
            className="px-4 py-2 rounded-lg border border-stone-300 disabled:opacity-40"
            disabled={delBusy || delCost.trim() === ""
              || !Number.isFinite(Number(delCost.replace(",", ".")))}
            onClick={() => {
              setDelBusy(true);
              setError(null);
              void setDeliveryCost(pin, Math.round(Number(delCost.replace(",", ".")) * 100) / 100)
                .then(async (saved) => {
                  setDelCost(String(saved));
                  setDelSaved(true);
                  await refreshSettings();
                })
                .catch((e) => setError(errorMessage(e, "That cost could not be saved")))
                .finally(() => setDelBusy(false));
            }}
          >
            {delBusy ? "Saving…" : delSaved ? "Saved" : "Save cost"}
          </button>
        </div>
      </div>

      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4 mt-4">
        <div>
          <h2 className="font-medium">Logo</h2>
          {/* Only on the A4 documents. The till slip is a 48-column thermal
              print and a logo on it is a grey smudge. */}
          <p className="text-sm text-stone-500">
            Printed at the head of an A4 quote or tax invoice. Not on the till
            slip, where it would only be a grey smudge.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {f.logo_url ? (
            <img
              src={imageSrc(f.logo_url) ?? ""}
              alt="The shop's logo"
              className="h-16 max-w-[200px] object-contain border border-stone-200 rounded bg-white p-1"
            />
          ) : (
            <span className="text-sm text-stone-500">
              No logo yet — documents set the shop's name in type.
            </span>
          )}
          <div className="flex gap-2 ml-auto">
            <button
              type="button"
              className="px-4 py-2 rounded-lg border border-stone-300 disabled:opacity-40"
              onClick={() => logoRef.current?.click()}
              disabled={logoBusy}
            >
              {logoBusy ? "Uploading…" : f.logo_url ? "Replace" : "Upload a logo"}
            </button>
            {f.logo_url && (
              <button
                type="button"
                className="px-4 py-2 rounded-lg text-red-700 disabled:opacity-40"
                onClick={() => void removeLogo()}
                disabled={logoBusy}
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={logoRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            aria-label="Upload a logo"
            onChange={(e) => void pickLogo(e.target.files?.[0])}
          />
        </div>
      </div>

      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4 mt-4">
        <div>
          <h2 className="font-medium">Printing</h2>
          <p className="text-sm text-stone-500">
            Kept on this device, not on the shop's account — the counter and a
            manager's laptop print to different things.
          </p>
        </div>

        {(
          [
            ["auto", "Work it out", "An Android tablet prints through RawBT; anything else goes straight to this machine's default printer."],
            ["direct", "Always straight to the printer", "Never show a slip on screen. Goes to whatever this machine prints to by default — set that to the till printer."],
            ["browser", "Always show the slip first", "For a device with no printer attached, or to read a slip before printing it."],
            ["thermal", "Always RawBT", "For a tablet that reports an unusual browser and is not recognised as Android."],
          ] as [PrintMode, string, string][]
        ).map(([value, label, blurb]) => (
          <label key={value} className="flex gap-3 items-start">
            <input
              type="radio"
              name="printmode"
              className="mt-1"
              checked={printMode === value}
              onChange={() => {
                setPrintMode(value);
                setPrintModeState(value);
              }}
            />
            <span>
              <span className="block text-sm text-stone-800">{label}</span>
              <span className="block text-xs text-stone-500">{blurb}</span>
            </span>
          </label>
        ))}

        {/* The half of this that is not ours to fix. Said here, next to the
            setting, because this is where somebody stands when they wonder why
            a dialog is still appearing. */}
        {printMode !== "browser" && printMode !== "thermal" && (
          <p className="text-xs text-stone-500 border-t border-stone-200 pt-3">
            The shop's own dialog is now gone. Chrome still shows ITS print
            dialog, and no web page can switch that off — it is a property of
            how Chrome was started, not of this app. To lose it too, launch the
            till with <code>--kiosk-printing</code>: right-click the shortcut,
            Properties, and add it to the end of the Target box, after a space.
            Chrome then prints to the default printer with no dialog at all.
          </p>
        )}

        <div className="border-t border-stone-200 pt-4">
          <h3 className="text-sm font-medium text-stone-800">How wide the slip is</h3>
          {/* The only real lever on the size of the print, and worth saying
              plainly: the type is sized so a full line just fits the paper, so
              a character is about (paper ÷ columns) and nothing else moves it
              by more than a few percent. */}
          <p className="text-xs text-stone-500 mt-1">
            This is what makes the print bigger or smaller. The type is sized so
            a full line just fits the roll, so fewer columns means bigger
            letters — and shorter room for a description.
          </p>
          <div className="flex gap-2 mt-3">
            {SLIP_WIDTHS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={cols === n}
                onClick={() => {
                  setSlipWidth(n as SlipWidth);
                  setCols(n);
                  publishSlipMetrics();
                }}
                className={`h-11 px-4 rounded-lg border text-sm font-medium ${
                  cols === n
                    ? "border-gold-400 bg-gold-50 text-colophon"
                    : "border-stone-200 text-stone-700"
                }`}
              >
                {n} columns
                <span className="block text-xs font-normal text-stone-500">
                  {n === 48 ? "smallest" : n === 40 ? "default" : "biggest"}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-xl bg-white rounded-xl border border-stone-200 p-5 space-y-4 mt-4">
        <div>
          <h2 className="font-medium">Small print</h2>
          {/* The customer who wants to return a special-order basin on day
              twelve reads the slip in their kitchen drawer, not the sign
              behind the counter. The policy goes on the slip, in the shop's
              own words, and can be changed the day the shop changes it. */}
          <p className="text-sm text-stone-500">
            Printed at the foot of every till slip and every quote. Leave a box
            empty to print nothing there.
          </p>
        </div>

        <label className="block">
          <span className="text-sm text-stone-600">On a till slip</span>
          <textarea
            className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2 min-h-[7rem]"
            value={f.receipt_terms}
            onChange={(e) => set("receipt_terms", e.target.value)}
            aria-label="Terms on a till slip"
          />
          <span className="text-xs text-stone-500">
            Returns, special orders, warranty, deliveries — the conditions of the sale.
          </span>
        </label>

        <label className="block">
          <span className="text-sm text-stone-600">On a quote</span>
          <textarea
            className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2 min-h-[5rem]"
            value={f.quote_terms}
            onChange={(e) => set("quote_terms", e.target.value)}
            aria-label="Terms on a quote"
          />
          <span className="text-xs text-stone-500">
            Nothing has been sold yet, so this is about validity and stock, not returns.
          </span>
        </label>
      </div>

      {/* One Save for the page, not one per card. Every card edits the same
          record and a single save writes all of it, so repeated buttons would
          only raise the question of which one this field belongs to.

          It floats at the foot of the pane rather than sitting at the bottom
          of the page. The page runs to banking details, printing, slip width
          and two blocks of small print, so the button was several screens
          below whatever had just been corrected — and a Save you have to go
          looking for is a Save that gets forgotten on the way. */}
      <div className="sticky bottom-0 z-10 max-w-xl flex items-center gap-3 mt-4 rounded-xl border border-stone-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
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
    receipt_terms: s.receipt_terms ?? "",
    quote_terms: s.quote_terms ?? "",
    logo_url: s.logo_url ?? "",
    quote_show_line_prices: s.quote_show_line_prices !== false,
  };
}
