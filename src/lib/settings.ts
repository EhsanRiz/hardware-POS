// Shop details for the invoice header.
//
// These live in the database rather than in build-time env vars, so the shop
// can correct its address or add a VAT number without a redeploy. They are
// cached on the device because the invoice header has to print during an
// outage, when the settings table is unreachable.
import { fetchSettings } from "./api";
import { cacheGet, cacheSet } from "./localCache";
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
};

/** The cached shop settings. Safe to call offline and before the first fetch. */
export function shopSettings(): ShopSettings {
  return cacheGet<ShopSettings>(KEY, FALLBACK);
}

/** Refresh from the server. Failures are ignored — the cache keeps the till up. */
export async function refreshSettings(): Promise<ShopSettings> {
  try {
    const s = await fetchSettings();
    cacheSet(KEY, s);
    return s;
  } catch {
    return shopSettings();
  }
}
