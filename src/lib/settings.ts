// Shop details for the invoice header.
//
// These live in the database rather than in build-time env vars, so the shop
// can correct its address or add a VAT number without a redeploy. They are
// cached on the device because the invoice header has to print during an
// outage, when the settings table is unreachable.
import { fetchSettings } from "./api";
import { VAT_RATE } from "./config";
import { cacheGet, cacheSet } from "./localCache";
import { imageSrc } from "./images";
import { primeLogo } from "./logoBytes";
import type { ShopSettings } from "./types";

const KEY = "shop.settings";

const FALLBACK: ShopSettings = {
  shop_name: "Hardware Shop",
  address_line1: "",
  address_line2: "",
  phone: "",
  vat_number: "",
  currency: "R",
  registration_number: "",
  email: "",
  bank_name: "",
  bank_account_name: "",
  bank_account_number: "",
  bank_branch_code: "",
  receipt_terms: "",
  quote_terms: "",
  logo_url: "",
  vat_rate: null,
  // A till that has never reached the server prints a full quote. Withholding
  // prices is a deliberate choice a shop makes, not something a device should
  // start doing because it could not read the setting.
  quote_show_line_prices: true,
};

/**
 * The VAT rate to show, as a fraction.
 *
 * Falls back to the build's constant only when the till has never reached the
 * server — a brand-new device on its first sale. Everywhere else this is the
 * figure the database will actually charge, so the screen and the invoice
 * cannot disagree the day a new rate takes effect.
 */
export function vatRate(): number {
  const r = shopSettings().vat_rate;
  return typeof r === "number" ? r : VAT_RATE;
}

/** The cached shop settings. Safe to call offline and before the first fetch. */
export function shopSettings(): ShopSettings {
  return cacheGet<ShopSettings>(KEY, FALLBACK);
}

/** Refresh from the server. Failures are ignored — the cache keeps the till up. */
export async function refreshSettings(): Promise<ShopSettings> {
  try {
    const s = await fetchSettings();
    cacheSet(KEY, s);
    // Into bytes now rather than at the moment somebody presses Email: a
    // document built inside a click cannot wait for a download.
    primeLogo(imageSrc(s.logo_url));
    return s;
  } catch {
    return shopSettings();
  }
}
