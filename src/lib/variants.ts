// Helpers for products that have variants (sizes / options). A product with a
// non-empty active `variants` list is "sized": the till shows a picker and each
// cart line carries the chosen variant.
import type { CartLine, Product, ProductVariant } from "./types";

export function activeVariants(p: Product): ProductVariant[] {
  return (p.variants ?? []).filter((v) => v.active);
}

export function hasVariants(p: Product): boolean {
  return activeVariants(p).length > 0;
}

// Label for a single variant within its product's picker, e.g. "Large" or
// "With Milk · Large". Falls back to "Option" if somehow blank.
export function variantOptionLabel(v: ProductVariant): string {
  const parts = [v.name?.trim(), v.size?.trim()].filter(Boolean);
  return parts.join(" · ") || "Option";
}

// Full display name for a cart line / receipt, combining product + variant, to
// match the server's pos_variant_label: "Americano (Large)", "Tea With Milk".
export function lineName(line: CartLine): string {
  const { product, variant } = line;
  if (!variant) return product.name;
  const name = variant.name?.trim();
  const size = variant.size?.trim();
  return (
    product.name +
    (name ? ` ${name}` : "") +
    (size ? ` (${size})` : "")
  ).trim();
}

export function linePrice(line: CartLine): number {
  return line.variant ? line.variant.price : line.product.price;
}

// Stable identity for a cart line (a product can appear under several variants).
export function lineKey(line: CartLine): string {
  return `${line.product.id}::${line.variant?.id ?? ""}`;
}

export function variantStock(v: ProductVariant): number | null {
  return v.stock_qty;
}

export function variantOut(v: ProductVariant): boolean {
  return v.stock_qty != null && v.stock_qty <= 0;
}
