import { API_BASE } from "./supabase";

/**
 * Product photographs.
 *
 * Two jobs: turn a stored path into something an <img> can load, and turn a
 * 4 MB photo from a tablet camera into something a shop's ADSL line can upload
 * and a till can cache.
 */

const BUCKET = "product-images";

/**
 * Where to load a product photo from.
 *
 * Stored images are a PATH, not a URL, so they resolve through the till's own
 * origin like every other backend call — an image loaded from a third-party
 * domain is one more thing a shop's network filter can block. Anything that
 * already looks like a URL (an imported catalogue, a supplier's website) is
 * passed through untouched.
 */
export function imageSrc(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  // Anything already carrying a scheme is complete: an http(s) URL from an
  // imported catalogue, or a data:/blob: image from the demo build or a local
  // preview. A site-relative path (/catalogue/…) is an asset shipped with the
  // app itself — supplier catalogue photographs live there, so they need no
  // storage round-trip at all. Only a bare storage path needs the origin and
  // bucket bolted on.
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith("/")) return pathOrUrl;
  return `${API_BASE}/storage/v1/object/public/${BUCKET}/${pathOrUrl}`;
}

/**
 * Shrink a camera photo before it is uploaded.
 *
 * A modern tablet takes 4000×3000 photographs of four megabytes. Uploading
 * that over a shop's line takes a minute the manager will not wait for, and
 * caching a few hundred of them would fill the tablet. 1400px on the long edge
 * is more than a till ever displays, and lands around 150 KB.
 *
 * EXIF orientation is handled by createImageBitmap, so a photo taken in
 * portrait does not arrive on its side.
 */
export async function downscaleImage(
  file: Blob,
  maxEdge = 1400,
  quality = 0.82
): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device cannot process images.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // JPEG, always: a photograph of a shelf gains nothing from PNG and costs
  // several times the bytes.
  return canvas.toDataURL("image/jpeg", quality);
}
