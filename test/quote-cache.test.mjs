/**
 * What a till remembers about quotes, and what it forgets.
 *
 * The screen's own test (e2e) proves a quote read once opens on its lines with
 * the line down. What a browser test cannot show is the BOUND: localStorage is
 * small and shared with the catalogue, the customers, the queues and the
 * roster, so a cache that grows by one entry per quote anybody ever opens is a
 * quota error waiting for the busiest day. That rule is pure, so it is held
 * here.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/quoteCache.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exports_ = {};
new Function("exports", "require", js)(exports_, () => ({}));
const { cachedLines, rememberLines, ITEMS_KEPT } = exports_;

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` → got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

const line = (n) => [{ name: `item ${n}`, qty: n }];

// A quote never read is not in the cache, and says so rather than looking empty.
check("a quote this device has never opened", cachedLines({}, "q1"), null);
check("a quote it has", cachedLines({ q1: line(1) }, "q1"), line(1));

// An empty quote is a real answer and must not read as "never seen" — that is
// the difference between showing nothing and fetching again.
check("a quote with no lines is still remembered", cachedLines({ q1: [] }, "q1"), []);

// The bound.
let cache = {};
for (let i = 0; i < ITEMS_KEPT + 15; i++) cache = rememberLines(cache, `q${i}`, line(i));
check("never keeps more than the bound", Object.keys(cache).length, ITEMS_KEPT);
check("the oldest are the ones dropped", cachedLines(cache, "q0"), null);
check("the newest is kept", cachedLines(cache, `q${ITEMS_KEPT + 14}`), line(ITEMS_KEPT + 14));

// Re-reading a quote moves it to the end, so the one somebody is working
// through is not dropped just because they opened it first.
let c2 = {};
for (let i = 0; i < ITEMS_KEPT; i++) c2 = rememberLines(c2, `q${i}`, line(i));
c2 = rememberLines(c2, "q0", line(99));           // read the oldest again
c2 = rememberLines(c2, "new", line(1));           // and push one more in
check("a re-read quote survives the next eviction", cachedLines(c2, "q0"), line(99));
check("and the one after it went instead", cachedLines(c2, "q1"), null);

// Remembering must not mutate what it was handed: the caller writes the result
// to disk, and a function that edited the original would have already changed
// what is in memory whether the write succeeded or not.
const before = { q1: line(1) };
const after = rememberLines(before, "q2", line(2));
check("the cache handed in is left alone", Object.keys(before), ["q1"]);
check("and the new one has both", Object.keys(after).sort(), ["q1", "q2"]);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
