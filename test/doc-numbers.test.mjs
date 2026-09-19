/**
 * The numbers a till holds for a day with the line down.
 *
 * A slip printed offline carries a real invoice number because the till
 * reserved a block ahead of time. How big that block is, and when it is topped
 * up, decides how long a shop can trade with no line before the paper falls
 * back to a till reference — and how many numbers are burned as gaps if it
 * never uses them.
 *
 * The rules are pure once localStorage and the network are stubbed, so they
 * are held here rather than through a browser: "does the till ask for more
 * than the server will give" is not a question worth spending eleven minutes
 * of Playwright on.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/docNumbers.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

/** What the till asked the server for, in order. */
const asked = [];
let online = true;
const store = new Map();

/**
 * The server's own clamp, copied from pos_reserve_doc_numbers: a request is
 * trimmed to 50, and a till already holding 50 unspent is refused outright.
 * Copied rather than assumed, because a test that hands back whatever was
 * asked for would let the till ask for a thousand and call it working.
 */
let unspentOnServer = 0;
function reserveDocNumbers(_type, count) {
  asked.push(count);
  if (unspentOnServer >= 50) throw new Error("This till already holds enough numbers");
  const n = Math.min(Math.max(count, 1), 50);
  const from = 1 + asked.length * 1000; // distinct per call, value is not the point
  return Promise.resolve({ prefix: "INV-", padWidth: 6, from, to: from + n - 1 });
}

const stubs = {
  "./api": { reserveDocNumbers },
  "./localCache": {
    cacheGet: (k, fallback) => (store.has(k) ? store.get(k) : fallback),
    cacheSet: (k, v) => store.set(k, v),
  },
  "./offline": { isOnline: () => online },
};
const exports_ = {};
new Function("exports", "require", js)(exports_, (m) => stubs[m] ?? {});
const {
  BLOCK_SIZE, LOW_WATER, topUpDocNumbers, remainingDocNumbers,
  peekDocNumber, commitDocNumber,
} = exports_;

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` → got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

// The server trims a request to 50 and refuses a till holding that many, so a
// till asking for more would be silently given less than it thinks it has.
check("never asks for more than the server will give", BLOCK_SIZE <= 50, true);
// Topping up at or above the block size would ask while already full.
check("tops up before it is empty, and below the block", LOW_WATER < BLOCK_SIZE, true);
// A top-up happens with at most LOW_WATER - 1 in hand, so the server's
// "already holds enough" refusal (>= 50 unspent) can never be what answers.
check("a top-up can never trip the server's refusal", LOW_WATER - 1 < 50, true);

// An empty till asks for a whole block, and then holds one.
await topUpDocNumbers("sale");
check("asks for a full block when it holds none", asked, [BLOCK_SIZE]);
check("and then holds that many", remainingDocNumbers("sale"), BLOCK_SIZE);

// Full: it must not ask again.
await topUpDocNumbers("sale");
check("does not ask again while it is full", asked.length, 1);

// Spend down to exactly the low-water mark: still no ask.
const spend = (n) => {
  for (let i = 0; i < n; i++) commitDocNumber("sale", peekDocNumber("sale"));
};
spend(BLOCK_SIZE - LOW_WATER);
check("sits at the low-water mark", remainingDocNumbers("sale"), LOW_WATER);
await topUpDocNumbers("sale");
check("does not ask AT the mark, only below it", asked.length, 1);

// One more spent, and it tops up.
spend(1);
await topUpDocNumbers("sale");
check("asks once it is below the mark", asked.length, 2);
check("and is stocked again", remainingDocNumbers("sale"), LOW_WATER - 1 + BLOCK_SIZE);

// The whole point: a day with the line down. The till cannot reserve, and
// what it holds is what it has — then the caller falls back to a till ref.
online = false;
const held = remainingDocNumbers("sale");
spend(held);
await topUpDocNumbers("sale");
check("cannot reserve with the line down", asked.length, 2);
check("and runs out rather than inventing one", peekDocNumber("sale"), null);
// A number nobody has is not spendable, so nothing is corrupted by trying.
commitDocNumber("sale", null);
check("spending nothing changes nothing", remainingDocNumbers("sale"), 0);

// Back online, it recovers by itself.
online = true;
await topUpDocNumbers("sale");
check("and refills when the line returns", remainingDocNumbers("sale"), BLOCK_SIZE);

// The runway this buys, said plainly: sales between top-ups with no line.
console.log(`\n  offline runway: ${LOW_WATER} to ${LOW_WATER + BLOCK_SIZE} numbers in hand`);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
