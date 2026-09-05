/**
 * The A4 document as a real PDF, written by hand.
 *
 * WHY BY HAND. A quotation emailed to a builder has to arrive as an
 * attachment they can forward to their client, not as forty lines of plain
 * text in the body — which is what went out before, and what went out was the
 * 48-column till slip at that. A `mailto:` link cannot carry an attachment
 * (no browser allows it), so the file has to exist as bytes before the mail
 * app opens, and the only way to have bytes is to write them.
 *
 * The alternatives were a rendering library (half a megabyte in a till that
 * has to work through a fibre cut, and a second layout engine to keep in step
 * with the HTML one) or rasterising the DOM (a picture of a document, which a
 * bookkeeper cannot copy a figure out of). Both cost more than this does.
 *
 * A PDF is a text format. The base-14 fonts — Helvetica here — are assumed to
 * be present in every reader, so nothing is embedded and the file comes out
 * around 3 KB. What that costs is the width tables below: to centre a line or
 * right-align a column of money you have to know how wide the glyphs are, and
 * the reader will not tell you. The numbers are Adobe's own AFM metrics.
 *
 * It draws from the same `Sheet` the screen draws from, so the content cannot
 * drift. The styling is a separate copy of the same decisions, and that one
 * can: if you move a colour or a margin in index.css, move it here too.
 *
 * NOT HERE YET: an uploaded shop logo. The HTML document prints it; this sets
 * the shop's name in type instead. Embedding an image means re-encoding a PNG,
 * and it has not been built.
 */
import { money } from "./money";
import { SHEET_TITLE, shopReach, shopWhere, type Sheet } from "./sheet";
import type { ShopSettings } from "./types";

/** Adobe's Helvetica widths, per 1000 units, for the printable ASCII range. */
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
/** The same for Helvetica-Bold, which is wider — a bold total must still line
 *  up with the column above it. */
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];
/** The few glyphs above ASCII the documents actually use. */
const W_HIGH: Record<number, number> = {
  0xa0: 278, 0xa9: 737, 0xb0: 400, 0xb7: 278, 0xd7: 584, 0x96: 556, 0x97: 1000,
};

/**
 * Unicode in, WinAnsi byte out.
 *
 * 0xA0–0xFF is Latin-1 and needs no map. Above that only a handful of
 * characters reach a document: the middle dot between letterhead fields, the
 * multiplication sign in a line, the money formatter's THIN SPACE and true
 * minus. The thin space becomes an ordinary one — WinAnsi has nothing
 * narrower, and a customer checking a figure will not miss the difference.
 */
const REMAP: Record<number, number> = {
  0x2009: 0x20, 0x2212: 0x2d, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x27,
  0x2019: 0x27, 0x201c: 0x22, 0x201d: 0x22, 0x2022: 0x95, 0x2026: 0x85,
};

function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const b = REMAP[c] ?? c;
    out.push(b <= 0xff ? b : 0x3f);
  }
  return out;
}

/** How wide a string sets, in points. Exported so a test can check that a
 *  description stops before the column of quantities begins. */
export function widthOf(text: string, size: number, bold = false): number {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const b of winAnsi(text)) {
    w += b >= 32 && b <= 126 ? table[b - 32] : W_HIGH[b] ?? 556;
  }
  return (w * size) / 1000;
}

/** A PDF string literal: parentheses and backslashes escaped, high bytes octal. */
function pdfString(text: string): string {
  let out = "";
  for (const b of winAnsi(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out;
}

/** Break a paragraph to a width, on spaces. */
function wrap(text: string, size: number, max: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && widthOf(next, size, bold) > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

type Rgb = [number, number, number];
/* The house colours, the same values index.css sets. */
const INK: Rgb = [0.106, 0.165, 0.141];
const GREEN: Rgb = [0.055, 0.227, 0.176];
const AMBER: Rgb = [0.784, 0.569, 0.184];
const GREY: Rgb = [0.333, 0.384, 0.357];
const HAIR: Rgb = [0.84, 0.83, 0.81];

const MM = 72 / 25.4;
const PAGE = { w: 595.28, h: 841.89 };
const TOP = 14 * MM;
const SIDE = 16 * MM;
const RIGHT = PAGE.w - SIDE;
/** What the foot of the page needs, so the lines stop above it. */
const FOOT = 22 * MM;

const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** One page's content stream, written top-down in millimetres of ink. */
class Sheet2Pdf {
  private streams: string[] = [];
  private ops: string[] = [];
  /** Distance from the top of the page, which is how a person reads it. */
  y = TOP;

  page() {
    if (this.ops.length) this.streams.push(this.ops.join("\n"));
    this.ops = [];
    this.y = TOP;
  }

  done(): string[] {
    if (this.ops.length) this.streams.push(this.ops.join("\n"));
    this.ops = [];
    return this.streams;
  }

  get pageCount() {
    return this.streams.length + (this.ops.length ? 1 : 0);
  }

  text(
    s: string,
    x: number,
    size: number,
    opts: { bold?: boolean; colour?: Rgb; align?: "left" | "right" | "centre"; y?: number } = {}
  ) {
    const { bold = false, colour = INK, align = "left" } = opts;
    const top = opts.y ?? this.y;
    const w = widthOf(s, size, bold);
    const at = align === "right" ? x - w : align === "centre" ? x - w / 2 : x;
    this.ops.push(
      `BT /${bold ? "F2" : "F1"} ${n2(size)} Tf ` +
        `${colour.map(n2).join(" ")} rg ` +
        `1 0 0 1 ${n2(at)} ${n2(PAGE.h - top - size * 0.8)} Tm ` +
        `(${pdfString(s)}) Tj ET`
    );
  }

  rule(x1: number, x2: number, weight: number, colour: Rgb, top?: number) {
    const at = PAGE.h - (top ?? this.y);
    this.ops.push(
      `${colour.map(n2).join(" ")} RG ${n2(weight)} w ` +
        `${n2(x1)} ${n2(at)} m ${n2(x2)} ${n2(at)} l S`
    );
  }
}

/** Assemble the objects, the cross-reference table and the trailer. */
function assemble(streams: string[]): Uint8Array<ArrayBuffer> {
  const objs: string[] = [];
  const pageIds: number[] = [];
  // 1 catalogue, 2 page tree, 3 and 4 the two fonts; the pages follow.
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  for (const stream of streams) {
    const contentId = objs.length + 2;
    pageIds.push(objs.length + 1);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(PAGE.w)} ${n2(PAGE.h)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs[1] =
    `<< /Type /Pages /Count ${pageIds.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Backed by a plain ArrayBuffer so it can go straight into a File.
  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** The quotation or tax invoice, as a file a builder can forward. */
export function sheetAsPdf(sheet: Sheet, s: ShopSettings): Uint8Array<ArrayBuffer> {
  const p = new Sheet2Pdf();
  const title = SHEET_TITLE[sheet.kind];
  const centre = PAGE.w / 2;
  const owed = sheet.kind === "invoice" && !sheet.paidWith;

  const letterhead = () => {
    p.text(s.shop_name, centre, 19, { bold: true, colour: GREEN, align: "centre" });
    p.y += 21;
    const where = shopWhere(s).join(", ");
    if (where) {
      p.text(where, centre, 9, { colour: GREY, align: "centre" });
      p.y += 11;
    }
    const reach = shopReach(s).join(" · ");
    if (reach) {
      p.text(reach, centre, 9, { colour: GREY, align: "centre" });
      p.y += 11;
    }
    p.y += 5;
    p.rule(SIDE, RIGHT, 1, AMBER);
    p.y += 14;
  };

  /* The columns of the line table, and the head that names them. */
  const CODE = SIDE;
  const DESC = SIDE + 74;
  const AMOUNT = RIGHT;
  const PRICE = RIGHT - 78;
  const QTY = RIGHT - 150;
  const tableHead = () => {
    p.text("CODE", CODE, 8, { bold: true, colour: GREEN });
    p.text("DESCRIPTION", DESC, 8, { bold: true, colour: GREEN });
    p.text("QTY", QTY, 8, { bold: true, colour: GREEN, align: "right" });
    p.text("UNIT PRICE", PRICE, 8, { bold: true, colour: GREEN, align: "right" });
    p.text("AMOUNT", AMOUNT, 8, { bold: true, colour: GREEN, align: "right" });
    p.y += 11;
    p.rule(SIDE, RIGHT, 0.8, GREEN);
    p.y += 8;
  };

  letterhead();

  // The title on the left, its details on the right, the way the screen sets
  // them.
  const titleTop = p.y;
  p.text(title, SIDE, 17, { bold: true, colour: GREEN });
  const meta: [string, string][] = [
    ["Number", sheet.number],
    ["Date", sheet.date],
  ];
  if (sheet.validUntil) meta.push(["Valid until", sheet.validUntil]);
  if (sheet.poNumber) meta.push(["Your order", sheet.poNumber]);
  if (sheet.servedBy) meta.push(["Served by", sheet.servedBy]);
  for (const [k, v] of meta) {
    p.text(k, RIGHT - 110, 9.5, { colour: GREY });
    p.text(v, RIGHT, 9.5);
    p.y += 13;
  }
  p.y = Math.max(p.y, titleTop + 26) + 8;

  p.text(sheet.kind === "quote" ? "QUOTATION FOR" : "INVOICED TO", SIDE, 8, { colour: GREY });
  p.y += 12;
  p.text(
    sheet.customer.name ?? (sheet.kind === "quote" ? "Walk-in customer" : "Cash sale"),
    SIDE,
    11.5,
    { bold: true }
  );
  p.y += 14;
  for (const line of [
    sheet.customer.address,
    sheet.customer.phone,
    sheet.customer.vatNumber ? `VAT No ${sheet.customer.vatNumber}` : "",
    sheet.trade ? "Trade pricing" : "",
  ]) {
    if (!line) continue;
    p.text(line, SIDE, 9.5, { colour: GREY });
    p.y += 12;
  }
  p.y += 10;

  tableHead();
  for (const l of sheet.lines) {
    // A line that will not fit above the foot starts the next page, under a
    // repeat of the head — a column of figures with no heading is a puzzle.
    if (p.y > PAGE.h - FOOT - 30) {
      p.page();
      tableHead();
    }
    // Stop well short of the quantity column: PRICE - DESC is the space to
    // the unit price, but the quantities sit between the two, and a long
    // description set to that width ran straight through them.
    const desc = wrap(l.description, 10, QTY - 62 - DESC);
    if (l.code) p.text(l.code, CODE, 9, { colour: GREY });
    p.text(desc[0] ?? "", DESC, 10);
    p.text(`${l.qty} ${l.unit}`, QTY, 10, { align: "right" });
    p.text(money(l.unitPrice), PRICE, 10, { align: "right" });
    p.text(money(l.lineTotal), AMOUNT, 10, { align: "right" });
    p.y += 13;
    for (const extra of desc.slice(1)) {
      p.text(extra, DESC, 10);
      p.y += 12;
    }
    if (l.discount) {
      p.text(`less ${money(l.discount)}`, AMOUNT, 8.5, { colour: GREY, align: "right" });
      p.y += 11;
    }
    p.y += 3;
    p.rule(SIDE, RIGHT, 0.4, HAIR);
    p.y += 6;
  }

  // The totals on the right; the small print and the signature on the left,
  // both starting from the same line.
  p.y += 8;
  const splitTop = p.y;
  const totals: [string, string, boolean][] = [
    ["Subtotal", money(sheet.subtotal), false],
  ];
  if (sheet.discount > 0) totals.push(["Discount", `-${money(sheet.discount)}`, false]);
  totals.push(["VAT", money(sheet.vat), false]);
  totals.push(["Total", money(sheet.total), true]);
  if (sheet.paidWith) totals.push(["Paid", sheet.paidWith, false]);
  for (const [k, v, big] of totals) {
    if (big) {
      p.y += 3;
      p.rule(RIGHT - 160, RIGHT, 1, AMBER);
      p.y += 6;
    }
    p.text(k, RIGHT - 160, big ? 12 : 9.5, { bold: big, colour: big ? GREEN : GREY });
    p.text(v, RIGHT, big ? 12 : 9.5, { bold: big, colour: big ? GREEN : INK });
    p.y += big ? 17 : 13;
  }
  const afterTotals = p.y;

  p.y = splitTop;
  const leftWidth = RIGHT - 175 - SIDE;
  const terms = (sheet.kind === "quote" ? s.quote_terms : s.receipt_terms) ?? "";
  for (const block of [sheet.note ?? "", terms.trim()]) {
    if (!block) continue;
    for (const line of wrap(block, 9, leftWidth)) {
      p.text(line, SIDE, 9, { colour: GREY });
      p.y += 11;
    }
    p.y += 6;
  }
  const banking: [string, string][] = (
    [
      ["Bank", s.bank_name],
      ["Account name", s.bank_account_name],
      ["Account no", s.bank_account_number],
      ["Branch code", s.bank_branch_code],
    ] as [string, string | null | undefined][]
  ).filter(([, v]) => (v ?? "").trim() !== "") as [string, string][];
  if (owed && banking.length) {
    for (const [k, v] of banking) {
      p.text(k, SIDE, 9, { colour: GREY });
      p.text(v, SIDE + 80, 9);
      p.y += 12;
    }
    p.y += 6;
  }
  if (sheet.kind === "quote") {
    p.text("ACCEPTED BY", SIDE, 8, { colour: GREY });
    p.y += 30;
    const cols: [string, number, number][] = [
      ["Name", SIDE, 110],
      ["Signature", SIDE + 125, 110],
      ["Date", SIDE + 250, 70],
    ];
    for (const [label, x, w] of cols) {
      p.rule(x, x + w, 0.6, GREY);
      p.text(label, x, 8.5, { colour: GREY, y: p.y + 3 });
    }
    p.y += 15;
  }

  // The foot goes at the foot of the page, as it does on screen.
  p.y = Math.max(p.y, afterTotals);
  const foot = PAGE.h - FOOT;
  if (p.y > foot) p.page();
  p.y = foot;
  p.rule(SIDE, RIGHT, 0.4, HAIR);
  p.y += 9;
  p.text(`${s.shop_name} · ${title} ${sheet.number}`, centre, 8, {
    colour: GREY, align: "centre",
  });
  p.y += 11;
  p.text(
    "E&OE. This document is computer generated and is valid without a signature.",
    centre, 8, { colour: GREY, align: "centre" }
  );
  p.y += 13;
  p.text(
    `InnovaPOS · a product of InnovaEarth · © ${new Date().getFullYear()} InnovaEarth · All rights reserved`,
    centre, 7.5, { colour: GREY, align: "centre" }
  );

  return assemble(p.done());
}

/** What the attachment is called when it lands in someone's downloads. */
export function sheetFileName(sheet: Sheet): string {
  return `${SHEET_TITLE[sheet.kind].replace(/\s+/g, "-")}-${sheet.number}.pdf`;
}
