/**
 * Code 128, code set B: every printable ASCII character, which is all a
 * document number needs. Used twice — the thermal printer draws its own from
 * the same text via ESC/POS, and the on-screen preview draws this one — and
 * proved once, by the browser suite handing the drawn bars to the shelf's
 * decoder and reading the number back.
 */

// Bar/space widths for values 0–106 (11 modules each; the stop is 13).
const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];
const START_B = 104;
const STOP = 106;

/** The symbol values for a string, check digit included. */
export function code128Values(text: string): number[] {
  const values = [START_B];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Code 128 B cannot encode ${JSON.stringify(ch)}`);
    values.push(c - 32);
  }
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** Alternating bar and space widths, in modules, bars first. */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap((v) => PATTERNS[v].split("").map(Number));
}

/** An SVG of the barcode, quiet zones included, sized in modules × `mod` px. */
export function code128Svg(text: string, mod = 2, height = 48): string {
  const widths = code128Widths(text);
  const quiet = 10;
  const total = widths.reduce((t, w) => t + w, 0) + quiet * 2;
  let x = quiet;
  const rects: string[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects.push(`<rect x="${x * mod}" y="0" width="${w * mod}" height="${height}" />`);
    x += w;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total * mod}" height="${height}" ` +
    `viewBox="0 0 ${total * mod} ${height}" shape-rendering="crispEdges" role="img" aria-label="Barcode ${text}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`
  );
}
