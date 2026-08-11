import { useCallback, useEffect, useRef, useState } from "react";
import {
  listProductImages,
  removeProductImage,
  uploadProductImage,
  type ProductImage,
} from "../lib/adminApi";
import { errorMessage } from "../lib/errors";
import { downscaleImage, imageSrc } from "../lib/images";
import { useOnline } from "../lib/offline";

/**
 * Photographs of a product, taken at the shelf.
 *
 * Why this earns its place: a hardware catalogue is full of items whose
 * descriptions are nearly identical — eight garden hose sets differing only by
 * length and colour, six sizes of the same anchor bolt. A cashier reading those
 * under time pressure will eventually ring up the wrong one. A picture settles
 * it in a glance, which is why these also appear in the till's search results
 * and not only here.
 *
 * The camera is the point. `capture="environment"` opens the rear camera
 * directly on a tablet, so a manager walks the aisle photographing stock rather
 * than sitting at a desk hunting for supplier images.
 */
export default function ProductPhotos({
  productId,
  pin,
}: {
  /** Null while a new product is still unsaved — there is nothing to attach to. */
  productId: string | null;
  pin: string;
}) {
  const online = useOnline();
  const [images, setImages] = useState<ProductImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!productId) return;
    try {
      setImages(await listProductImages(productId));
    } catch (e) {
      setError(errorMessage(e, "Could not load the photos"));
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(files: FileList | null) {
    if (!productId || !files?.length) return;
    setBusy(true);
    setError(null);
    try {
      // One at a time: a shop's upload line is thin, and a failure halfway
      // through should leave the photos that already worked in place.
      for (const file of Array.from(files)) {
        const dataUrl = await downscaleImage(file);
        await uploadProductImage(pin, productId, dataUrl);
      }
      await load();
    } catch (e) {
      setError(errorMessage(e, "The photo could not be uploaded"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(image: ProductImage) {
    setBusy(true);
    setError(null);
    try {
      await removeProductImage(pin, image.id);
      await load();
    } catch (e) {
      setError(errorMessage(e, "Could not remove that photo"));
    } finally {
      setBusy(false);
    }
  }

  if (!productId) {
    return (
      <p className="text-sm text-stone-500">
        Save the product first, then add photos.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => (
          <figure key={img.id} className="relative">
            <img
              src={imageSrc(img.url) ?? ""}
              alt=""
              className="w-24 h-24 object-cover rounded border border-stone-200 bg-stone-50"
              loading="lazy"
            />
            {/* The first photo is what the till shows in a search result. */}
            {i === 0 && (
              <figcaption className="absolute bottom-0 inset-x-0 text-[10px] text-center bg-black/55 text-white rounded-b">
                on the till
              </figcaption>
            )}
            <button
              type="button"
              onClick={() => remove(img)}
              disabled={busy}
              aria-label="Remove this photo"
              className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white border
                         border-stone-300 text-stone-600 leading-none disabled:opacity-40"
            >
              ×
            </button>
          </figure>
        ))}

        {/* Two ways in, because they are genuinely different jobs: photograph
            the thing on the shelf, or attach a supplier's image from the
            tablet. `capture` makes the first one a single tap. */}
        <label
          className={`w-24 h-24 rounded border border-dashed border-stone-300 flex
                      flex-col items-center justify-center gap-1 text-xs text-stone-500
                      ${busy || !online ? "opacity-40" : "cursor-pointer hover:border-stone-400"}`}
        >
          <CameraGlyph />
          {busy ? "Working…" : "Take photo"}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            disabled={busy || !online}
            onChange={(e) => void add(e.target.files)}
            className="sr-only"
          />
        </label>
      </div>

      {!online && (
        <p className="text-xs text-stone-500">
          Photos need a connection — the rest of the product saves offline.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {images.length === 0 && !error && (
        <p className="text-xs text-stone-500">
          A photo makes a near-identical item unmistakable at the counter.
        </p>
      )}
    </div>
  );
}

function CameraGlyph() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </svg>
  );
}
