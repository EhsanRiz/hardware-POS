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
 * An uploaded shop logo rides along as a JPEG /DCTDecode stream — see
 * logoBytes.ts for why JPEG and why it is loaded ahead of the click. Without
 * one the document sets the shop's name in type, which is a letterhead too.
 */
import { money } from "./money";
import { SHEET_PRICED, SHEET_TITLE, shopReach, shopWhere, type Sheet } from "./sheet";
import type { PdfImage } from "./logoBytes";
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

  /** Place /Im1, given its drawn size in points and its top-left corner. */
  image(x: number, top: number, w: number, h: number) {
    this.ops.push(
      `q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(PAGE.h - top - h)} cm /Im1 Do Q`
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
function assemble(streams: string[], logo: PdfImage | null): Uint8Array<ArrayBuffer> {
  const objs: string[] = [];
  const pageIds: number[] = [];
  // 1 catalogue, 2 page tree, 3 and 4 the two fonts; the logo, if there is one,
  // is 5, and the pages follow.
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  let xobject = "";
  if (logo) {
    // The JPEG goes in whole: /DCTDecode is the reader's own decoder, so there
    // is nothing to re-encode and nothing to get wrong.
    let raw = "";
    for (const b of logo.jpeg) raw += String.fromCharCode(b);
    objs.push(
      `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${raw.length} >>\nstream\n${raw}\nendstream`
    );
    xobject = " /XObject << /Im1 5 0 R >>";
  }
  for (const stream of streams) {
    const contentId = objs.length + 2;
    pageIds.push(objs.length + 1);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(PAGE.w)} ${n2(PAGE.h)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobject} >> /Contents ${contentId} 0 R >>`
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
export function sheetAsPdf(
  sheet: Sheet,
  s: ShopSettings,
  logo: PdfImage | null = null
): Uint8Array<ArrayBuffer> {
  const p = new Sheet2Pdf();
  const title = SHEET_TITLE[sheet.kind];
  const centre = PAGE.w / 2;
  // Where to pay. A statement is a request for money as much as an unpaid
  // invoice is, and sending one without bank details is asking twice.
  const owed = (sheet.kind === "invoice" && !sheet.paidWith)
    || (sheet.kind === "statement" && sheet.total > 0);
  const priced = SHEET_PRICED[sheet.kind];
  // A delivery note goes out twice: one copy is signed and comes back.
  const copies: (string | null)[] =
    sheet.kind === "delivery" ? ["CUSTOMER COPY", "SHOP COPY"] : [null];

  /**
   * The foot of the page: what this document is, the disclaimer, the mark.
   *
   * Hoisted out of the end of the copies loop because the statement branch
   * leaves that loop early, and so shipped as the one document in the app
   * with no footer at all. Every path now ends here.
   */
  const pageFoot = () => {
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
  };

  const letterhead = () => {
    if (logo) {
      // The same box the screen gives it: 20mm tall, 80mm wide, centred, and
      // never stretched.
      const fit = Math.min((20 * MM) / logo.height, (80 * MM) / logo.width);
      const w = logo.width * fit;
      const h = logo.height * fit;
      p.image(centre - w / 2, p.y, w, h);
      p.y += h + 3 * MM;
    }
    // The name is set whether or not there is a mark above it: a mark is not a
    // name, and a tax invoice must carry the supplier's.
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
  /* A statement has no quantities and no unit prices: date, what it was,
     what it cost, what was paid, and where the balance stood after it. */
  const S_DATE = SIDE;
  const S_REF = SIDE + 66;
  const S_DETAIL = SIDE + 148;
  const S_BALANCE = RIGHT;
  const S_PAYMENT = RIGHT - 76;
  const S_CHARGE = RIGHT - 152;
  const statementHead = () => {
    p.text("DATE", S_DATE, 8, { bold: true, colour: GREEN });
    p.text("REFERENCE", S_REF, 8, { bold: true, colour: GREEN });
    p.text("DETAIL", S_DETAIL, 8, { bold: true, colour: GREEN });
    p.text("CHARGE", S_CHARGE, 8, { bold: true, colour: GREEN, align: "right" });
    p.text("PAID", S_PAYMENT, 8, { bold: true, colour: GREEN, align: "right" });
    p.text("BALANCE", S_BALANCE, 8, { bold: true, colour: GREEN, align: "right" });
    p.y += 11;
    p.rule(SIDE, RIGHT, 0.8, GREEN);
    p.y += 8;
  };
  const tableHead = () => {
    p.text("CODE", CODE, 8, { bold: true, colour: GREEN });
    p.text("DESCRIPTION", DESC, 8, { bold: true, colour: GREEN });
    p.text("QTY", QTY, 8, { bold: true, colour: GREEN, align: "right" });
    if (priced) {
      p.text("UNIT PRICE", PRICE, 8, { bold: true, colour: GREEN, align: "right" });
      p.text("AMOUNT", AMOUNT, 8, { bold: true, colour: GREEN, align: "right" });
    }
    p.y += 11;
    p.rule(SIDE, RIGHT, 0.8, GREEN);
    p.y += 8;
  };

  // Each copy is the whole document again, from its own letterhead: a second
  // page that says "shop copy" under a first page's heading is not a second
  // copy of anything.
  for (const copy of copies) {
    if (copy !== copies[0]) p.page();
    letterhead();

    // The title on the left, its details on the right, the way the screen sets
    // them.
    const titleTop = p.y;
    p.text(title, SIDE, 17, { bold: true, colour: GREEN });
    if (copy) {
      p.text(copy, SIDE, 8, { colour: AMBER, y: p.y + 21 });
    }
    const meta: [string, string][] = [
      ["Number", sheet.number],
      ["Date", sheet.date],
    ];
    if (sheet.statement) {
      meta.push(["Period", `${sheet.statement.from} to ${sheet.statement.to}`]);
    }
    if (sheet.validUntil) meta.push(["Valid until", sheet.validUntil]);
    if (sheet.deliverOn) meta.push(["Deliver on", sheet.deliverOn]);
    if (sheet.deliverAt) meta.push(["Time", sheet.deliverAt]);
    if (sheet.invoiceNumber) meta.push(["Invoice", sheet.invoiceNumber]);
    if (sheet.poNumber) meta.push(["Your order", sheet.poNumber]);
    if (sheet.servedBy) meta.push(["Served by", sheet.servedBy]);
    for (const [k, v] of meta) {
      // Label and value sit on one line only while the value fits beside it.
      // A statement's reference and its period are both far wider than the
      // gap, and were drawn straight back over the label — "Number" and
      // "STM-20260906-2F0B67" on top of each other.
      if (widthOf(v, 9.5) <= 110 - 6) {
        p.text(k, RIGHT - 110, 9.5, { colour: GREY });
        p.text(v, RIGHT, 9.5, { align: "right" });
        p.y += 13;
      } else {
        p.text(k, RIGHT, 8, { colour: GREY, align: "right" });
        p.y += 10;
        p.text(v, RIGHT, 9.5, { align: "right" });
        p.y += 14;
      }
    }
    p.y = Math.max(p.y, titleTop + 26) + 8;

    p.text(
      sheet.kind === "quote" ? "QUOTATION FOR"
        : sheet.kind === "delivery" ? "DELIVER TO" : "INVOICED TO",
      SIDE, 8, { colour: GREY }
    );
    p.y += 12;
    p.text(
      sheet.customer.name ?? (sheet.kind === "quote" ? "Walk-in customer" : "Cash sale"),
      SIDE,
      11.5,
      { bold: true }
    );
    p.y += 14;
    for (const line of [
      ...(sheet.deliverTo ?? "").split("\n"),
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

    if (sheet.statement) {
      const st = sheet.statement;
      statementHead();

      // The figure the whole page hangs off. A statement whose lines do not
      // start from a stated opening balance is a list, not a statement.
      p.text("Balance brought forward", S_DETAIL, 10, { bold: true });
      p.text(money(st.opening), S_BALANCE, 10, { bold: true, align: "right" });
      p.y += 13;
      p.rule(SIDE, RIGHT, 0.4, HAIR);
      p.y += 6;

      for (const e of st.entries) {
        if (p.y > PAGE.h - FOOT - 30) {
          p.page();
          statementHead();
        }
        const detail = wrap(e.detail, 10, S_CHARGE - 54 - S_DETAIL);
        p.text(e.date, S_DATE, 9, { colour: GREY });
        if (e.ref) p.text(e.ref, S_REF, 9, { colour: GREY });
        p.text(detail[0] ?? "", S_DETAIL, 10);
        if (e.charge) p.text(money(e.charge), S_CHARGE, 10, { align: "right" });
        if (e.payment) p.text(money(e.payment), S_PAYMENT, 10, { align: "right" });
        p.text(money(e.balance), S_BALANCE, 10, { align: "right" });
        p.y += 13;
        for (const extra of detail.slice(1)) {
          p.text(extra, S_DETAIL, 10);
          p.y += 12;
        }
        p.y += 3;
        p.rule(SIDE, RIGHT, 0.4, HAIR);
        p.y += 6;
      }

      p.y += 8;
      const stTop = p.y;
      const stTotals: [string, string, boolean][] = [
        ["Brought forward", money(st.opening), false],
        ["Charged", money(st.charges), false],
        ["Paid", `-${money(st.payments)}`, false],
        ["Balance now due", money(st.closing), true],
      ];
      for (const [k, v, big] of stTotals) {
        if (big) {
          p.y += 3;
          p.rule(RIGHT - 160, RIGHT, 1, AMBER);
          p.y += 6;
        }
        p.text(k, RIGHT - 160, big ? 12 : 9.5, { bold: big, colour: big ? GREEN : GREY });
        p.text(v, RIGHT, big ? 12 : 9.5, {
          bold: big, colour: big ? GREEN : INK, align: "right",
        });
        p.y += big ? 17 : 13;
      }
      const stAfter = p.y;

      // HOW OLD THE MONEY IS, on the left, opposite the totals. It is the
      // half of a statement that actually gets a shop paid.
      p.y = stTop;
      p.text("HOW OLD THIS IS", SIDE, 8, { colour: GREY });
      p.y += 12;
      for (const [k, v] of [
        ["Current", st.ageing.current],
        ["30 days", st.ageing.days30],
        ["60 days", st.ageing.days60],
        ["90+ days", st.ageing.days90],
      ] as [string, number][]) {
        p.text(k, SIDE, 9.5, { colour: GREY });
        p.text(money(v), SIDE + 150, 9.5, { align: "right" });
        p.y += 12;
      }
      p.y += 6;
      const stBanking: [string, string][] = (
        [
          ["Bank", s.bank_name],
          ["Account name", s.bank_account_name],
          ["Account no", s.bank_account_number],
          ["Branch code", s.bank_branch_code],
        ] as [string, string | null | undefined][]
      ).filter(([, v]) => (v ?? "").trim() !== "") as [string, string][];
      if (owed && stBanking.length) {
        for (const [k, v] of stBanking) {
          p.text(k, SIDE, 9, { colour: GREY });
          p.text(v, SIDE + 80, 9);
          p.y += 12;
        }
        p.y += 6;
      }
      const stTerms = (s.receipt_terms ?? "").trim();
      for (const line of stTerms ? wrap(stTerms, 9, RIGHT - 175 - SIDE) : []) {
        p.text(line, SIDE, 9, { colour: GREY });
        p.y += 11;
      }
      p.y = Math.max(p.y, stAfter);
      pageFoot();
      continue;
    }

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
      if (priced) {
        p.text(money(l.unitPrice), PRICE, 10, { align: "right" });
        p.text(money(l.lineTotal), AMOUNT, 10, { align: "right" });
      }
      p.y += 13;
      for (const extra of desc.slice(1)) {
        p.text(extra, DESC, 10);
        p.y += 12;
      }
      if (l.discount && priced) {
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
    const totals: [string, string, boolean][] = priced ? [
      ["Subtotal", money(sheet.subtotal), false],
    ] : [];
    if (priced) {
      if (sheet.discount > 0) totals.push(["Discount", `-${money(sheet.discount)}`, false]);
      totals.push(["VAT", money(sheet.vat), false]);
      totals.push(["Total", money(sheet.total), true]);
      if (sheet.paidWith) totals.push(["Paid", sheet.paidWith, false]);
    }
    for (const [k, v, big] of totals) {
      if (big) {
        p.y += 3;
        p.rule(RIGHT - 160, RIGHT, 1, AMBER);
        p.y += 6;
      }
      p.text(k, RIGHT - 160, big ? 12 : 9.5, { bold: big, colour: big ? GREEN : GREY });
      p.text(v, RIGHT, big ? 12 : 9.5, {
        bold: big, colour: big ? GREEN : INK, align: "right",
      });
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
    if (sheet.kind === "delivery") {
      // What the customer is actually signing: quantities and condition. The
      // exceptions box is the useful half — a driver who writes "1 bag torn"
      // there has settled an argument that would otherwise happen a week
      // later with nothing written down.
      p.text("GOODS RECEIVED", SIDE, 8, { colour: GREY });
      p.y += 12;
      for (const line of wrap(
        "I confirm that the goods listed above were received in the quantities " +
        "shown and in good condition, and that any shortage, breakage or damage " +
        "has been noted below.", 9, leftWidth
      )) {
        p.text(line, SIDE, 9, { colour: INK });
        p.y += 11;
      }
      p.y += 4;
      p.text("NOTES / EXCEPTIONS", SIDE, 8, { colour: GREY });
      p.y += 14;
      for (let i = 0; i < 3; i++) {
        p.rule(SIDE, SIDE + leftWidth, 0.4, HAIR);
        p.y += 14;
      }
      p.y += 4;
      const cols: [string, number, number][] = [
        ["Received by (print name)", SIDE, 130],
        ["Signature", SIDE + 145, 110],
        ["Date", SIDE + 270, 70],
      ];
      p.y += 22;
      for (const [label, x, w] of cols) {
        p.rule(x, x + w, 0.6, GREY);
        p.text(label, x, 8.5, { colour: GREY, y: p.y + 3 });
      }
      p.y += 15;
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
    pageFoot();
  }

  return assemble(p.done(), logo);
}

/** What the attachment is called when it lands in someone's downloads. */
export function sheetFileName(sheet: Sheet): string {
  return `${SHEET_TITLE[sheet.kind].replace(/\s+/g, "-")}-${sheet.number}.pdf`;
}
