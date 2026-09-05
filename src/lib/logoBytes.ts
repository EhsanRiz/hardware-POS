/**
 * The shop's logo, as bytes a PDF can carry.
 *
 * Two constraints shape this. A PDF cannot reference a picture by URL — the
 * image has to be inside the file — and `navigator.share` has to be called
 * inside the click that asked for it, so the document cannot be built from an
 * async fetch at the moment someone presses Email. The logo is therefore
 * loaded once, ahead of time, and kept.
 *
 * It is converted to JPEG on the way through. A PDF can embed JPEG bytes
 * verbatim with /DCTDecode; a PNG would have to be decoded and re-compressed
 * to something a reader understands, which is a great deal of code for a shop
 * badge. Photographs and flat logos both survive quality 0.92.
 *
 * If any of it fails — the shop has no logo, the storage bucket is unreachable,
 * the canvas is tainted because the object came back without CORS headers —
 * the document sets the shop's name in type, which is what it did before and
 * is a perfectly good letterhead.
 */

export interface PdfImage {
  /** Raw JPEG, ready for a /DCTDecode stream. */
  jpeg: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

let cached: { src: string; image: PdfImage } | null = null;
let loading: { src: string; done: Promise<PdfImage | null> } | null = null;

/** Anything bigger is wasted: the document prints it 80mm wide at most. */
const MAX_EDGE = 700;

/** The logo for the documents, or null if there is not one ready. */
export function logoImage(): PdfImage | null {
  return cached?.image ?? null;
}

/**
 * Start loading the logo, if it is not already in hand. Returns nothing and
 * throws nothing: callers carry on and the logo turns up on the next document
 * if it turns up at all.
 */
export function primeLogo(src: string | null | undefined): void {
  void ensureLogo(src);
}

/**
 * The logo, waiting for it if it is still loading.
 *
 * Anything that can afford to wait should: a download built the instant the
 * settings changed would otherwise come out without the mark, and which of
 * those you get would depend on how fast somebody clicked. Emailing cannot
 * wait — `navigator.share` has to be called inside the click — which is what
 * priming is for.
 */
export function ensureLogo(src: string | null | undefined): Promise<PdfImage | null> {
  if (!src) {
    cached = null;
    return Promise.resolve(null);
  }
  if (cached?.src === src) return Promise.resolve(cached.image);
  if (loading?.src === src) return loading.done;
  const done = load(src)
    .then((image) => {
      if (image) cached = { src, image };
      return image;
    })
    .catch(() => null)
    .finally(() => {
      if (loading?.src === src) loading = null;
    });
  loading = { src, done };
  return done;
}

async function load(src: string): Promise<PdfImage | null> {
  if (typeof document === "undefined") return null;
  const img = new Image();
  // Without this the canvas is tainted and toDataURL throws, even though the
  // object itself loaded perfectly well.
  img.crossOrigin = "anonymous";
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("logo did not load"));
  });
  img.src = src;
  await loaded;

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // JPEG has no transparency, and a logo saved as a transparent PNG would come
  // out on black. White is the paper it is going onto.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const url = canvas.toDataURL("image/jpeg", 0.92);
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const jpeg = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);
  return { jpeg, width, height };
}
