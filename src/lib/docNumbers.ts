// The numbers this till holds, so a slip printed with the line down carries
// a real invoice number.
//
// Invoice and delivery-note numbers are issued by the server, so two tills
// never issue the same one. A sale taken offline therefore had none until it
// synced, and the shop wants the number on the paper, line or no line. So
// the till RESERVES a block ahead of time (pos_reserve_doc_numbers, 0096),
// keeps it here in localStorage, and gives each sale the next one itself —
// online too, so one till's numbers run in the order its sales were made.
// The server keeps the number the till gave, having checked it is this
// till's and unspent.
//
// A number is only spent once the sale that carries it is accepted or
// queued: a sale the server refused (stock, credit) hands its number back,
// and so does one the server parked for approval, which has no number until
// it is released. When the block runs out with the line still down, the slip
// falls back to a till reference (receipt.ts, tillRef).
import { reserveDocNumbers } from "./api";
import { cacheGet, cacheSet } from "./localCache";
import { isOnline } from "./offline";

export type DocType = "sale" | "delivery";

interface Block {
  prefix: string;
  padWidth: number;
  from: number;
  to: number;
  /** The next number to give; past `to` once the block is spent. */
  next: number;
}

const KEY = (t: DocType) => `docnums.${t}`;
/**
 * Reserved a block at a time, topped up once fewer than this remain.
 *
 * Fifty, not twenty-five, because twenty-five is thin for a whole day with
 * the line down: a shop that takes forty sales falls back to till references
 * for the last fifteen, and the paper the customer walks out with is then not
 * the number the invoice ends up carrying.
 *
 * Fifty is also the ceiling. pos_reserve_doc_numbers clamps a request to 50
 * and refuses a till already holding 50 unspent, so asking for more would be
 * silently trimmed rather than honoured. Topping up below 25 keeps the till
 * between 25 and 75 and never trips that refusal, since a top-up only ever
 * happens with at most 24 in hand.
 *
 * WHY NOT MORE. next_number advances by the whole block when it is reserved,
 * spent or not, so every number a till holds and does not use is a permanent
 * gap in the shop's invoice run — and unpairing a till abandons the lot. On a
 * VAT-registered book those gaps are what an auditor asks about. Going past
 * 50 is a migration and an accounting decision, not a constant.
 */
export const BLOCK_SIZE = 50;
export const LOW_WATER = 25;

function blocks(t: DocType): Block[] {
  return cacheGet<Block[]>(KEY(t), []);
}
function save(t: DocType, b: Block[]): void {
  cacheSet(KEY(t), b.filter((x) => x.next <= x.to));
}
function format(b: Block, n: number): string {
  return b.prefix + String(n).padStart(b.padWidth, "0");
}

/** How many numbers the till still holds. */
export function remainingDocNumbers(t: DocType): number {
  return blocks(t).reduce((n, b) => n + Math.max(0, b.to - b.next + 1), 0);
}

/** The next number, without spending it. Null when the till holds none. */
export function peekDocNumber(t: DocType): string | null {
  const b = blocks(t).find((x) => x.next <= x.to);
  return b ? format(b, b.next) : null;
}

/** Spend a number — only the one peekDocNumber gave, so a refusal costs nothing. */
export function commitDocNumber(t: DocType, n: string | null): void {
  if (!n) return;
  const all = blocks(t);
  const b = all.find((x) => x.next <= x.to);
  if (!b || format(b, b.next) !== n) return;
  b.next += 1;
  save(t, all);
}

/**
 * Let the numbers go. For when the server says they are not this till's —
 * the till was unpaired and paired again, and the old block died with the
 * old token — so the next sale asks the server to number it instead.
 */
export function dropDocNumbers(t: DocType): void {
  save(t, []);
}

/** Whether an error is the server refusing a number the till gave. */
export function isDocNumberError(e: unknown): boolean {
  const m = String((e as { message?: unknown })?.message ?? "");
  return /not one this till was given|has already been used/i.test(m);
}

const topping = new Set<DocType>();

/** Reserve another block when the line is up and the till is running low. */
export async function topUpDocNumbers(t: DocType): Promise<void> {
  if (topping.has(t) || !isOnline()) return;
  if (remainingDocNumbers(t) >= LOW_WATER) return;
  topping.add(t);
  try {
    const r = await reserveDocNumbers(t, BLOCK_SIZE);
    if (r) save(t, [...blocks(t), { ...r, next: r.from }]);
  } catch {
    // The line, or a till that already holds enough: either way the next
    // sale will try again. Nothing to say to the cashier.
  } finally {
    topping.delete(t);
  }
}

export function topUpAllDocNumbers(): void {
  void topUpDocNumbers("sale");
  void topUpDocNumbers("delivery");
}
