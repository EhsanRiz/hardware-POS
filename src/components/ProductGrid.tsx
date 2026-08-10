import { useEffect, useMemo, useState } from "react";
import type { Product, ProductVariant } from "../lib/types";
import {
  activeVariants,
  hasVariants,
  variantOptionLabel,
  variantOut,
} from "../lib/variants";
import { money } from "../lib/format";

const outOfStock = (p: Product) => p.stock_qty != null && p.stock_qty <= 0;

function TileShell({
  onClick,
  disabled,
  imageUrl,
  letter,
  badge,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  imageUrl: string | null;
  letter: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group relative h-52 rounded-xl bg-white border border-stone-200 overflow-hidden flex flex-col text-left transition-all duration-150 active:scale-95 hover:border-brand/40 hover:shadow-md hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none"
    >
      <div className="h-36 shrink-0 bg-brand-light flex items-center justify-center overflow-hidden">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <span className="text-3xl font-bold text-brand/40">{letter}</span>
        )}
      </div>
      {badge}
      <div className="flex-1 min-h-0 p-2.5 flex flex-col justify-center gap-0.5">
        {children}
      </div>
    </button>
  );
}

function ProductTile({
  p,
  onAdd,
  onPick,
}: {
  p: Product;
  onAdd: (p: Product, v?: ProductVariant) => void;
  onPick: (p: Product) => void;
}) {
  const variants = activeVariants(p);
  const sized = variants.length > 0;

  if (sized) {
    const minPrice = Math.min(...variants.map((v) => v.price));
    return (
      <TileShell
        onClick={() => onPick(p)}
        imageUrl={p.image_url}
        letter={p.name.charAt(0).toUpperCase()}
        badge={
          <span className="absolute top-1.5 right-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-brand text-white">
            {variants.length} sizes
          </span>
        }
      >
        <span className="font-medium text-stone-800 leading-tight line-clamp-2 text-sm">
          {p.name}
        </span>
        <span className="text-brand font-semibold">
          <span className="text-xs text-taupe font-normal">from </span>
          {money(minPrice)}
        </span>
      </TileShell>
    );
  }

  const tracked = p.stock_qty != null;
  const out = outOfStock(p);
  const low = tracked && !out && (p.stock_qty as number) <= 5;
  return (
    <TileShell
      onClick={() => onAdd(p)}
      disabled={out}
      imageUrl={p.image_url}
      letter={p.name.charAt(0).toUpperCase()}
      badge={
        tracked && (
          <span
            className={`absolute top-1.5 right-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
              out
                ? "bg-stone-700 text-white"
                : low
                ? "bg-amber-500 text-white"
                : "bg-white/90 text-stone-600"
            }`}
          >
            {out ? "Out" : `${p.stock_qty} left`}
          </span>
        )
      }
    >
      <span className="font-medium text-stone-800 leading-tight line-clamp-2 text-sm">
        {p.name}
      </span>
      <span className="text-brand font-semibold">{money(p.price)}</span>
    </TileShell>
  );
}

function SizePicker({
  product,
  onPick,
  onClose,
}: {
  product: Product;
  onPick: (p: Product, v: ProductVariant) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-sm animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-stone-100">
          <div>
            <p className="text-xs text-taupe uppercase tracking-wide">Choose size</p>
            <h2 className="text-xl font-bold text-stone-800">{product.name}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full flex items-center justify-center text-stone-500 hover:bg-stone-100 active:bg-stone-200 text-xl leading-none"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-2">
          {activeVariants(product).map((v) => {
            const out = variantOut(v);
            return (
              <button
                key={v.id}
                disabled={out}
                onClick={() => {
                  onPick(product, v);
                  onClose();
                }}
                className="w-full flex items-center justify-between h-14 px-4 rounded-xl border border-stone-200 active:bg-stone-50 disabled:opacity-50 disabled:active:bg-white"
              >
                <span className="font-semibold text-stone-800">
                  {variantOptionLabel(v)}
                  {out && <span className="ml-2 text-xs text-red-500">Out</span>}
                  {!out && v.stock_qty != null && (
                    <span className="ml-2 text-xs text-taupe">
                      {v.stock_qty} left
                    </span>
                  )}
                </span>
                <span className="text-brand font-semibold">{money(v.price)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface Props {
  products: Product[];
  onAdd: (p: Product, variant?: ProductVariant) => void;
  query?: string;
}

export default function ProductGrid({ products, onAdd, query = "" }: Props) {
  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category));
    return Array.from(set);
  }, [products]);

  const [active, setActive] = useState<string>("All");
  const [picker, setPicker] = useState<Product | null>(null);
  const q = query.trim().toLowerCase();
  const visible = q
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
      )
    : active === "All"
    ? products
    : products.filter((p) => p.category === active);

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 overflow-x-auto pb-3 shrink-0">
        {["All", ...categories].map((c) => (
          <button
            key={c}
            onClick={() => setActive(c)}
            className={`px-4 h-10 rounded-full whitespace-nowrap font-medium transition-colors ${
              active === c
                ? "bg-brand text-white"
                : "bg-white border border-stone-200 text-stone-700"
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 overflow-y-auto pr-1 content-start">
        {visible.map((p) => (
          <ProductTile key={p.id} p={p} onAdd={onAdd} onPick={setPicker} />
        ))}
        {visible.length === 0 && (
          <p className="text-stone-400 col-span-full mt-8 text-center">
            {q ? `No items match “${query.trim()}”.` : "No products yet."}
          </p>
        )}
      </div>

      {picker && hasVariants(picker) && (
        <SizePicker product={picker} onPick={onAdd} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
