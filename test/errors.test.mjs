/**
 * What a till tells the server about, and what it keeps to itself. The
 * rules are pure (src/lib/errorRules.ts); the sending is not tested here.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/errorRules.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { describe, worthSending, enqueue, isTheLine, OUTBOX_MAX, REPEAT_WINDOW_MS } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log("--- an error is described by name and message, with its stack ---");
const e = new TypeError("Cannot read properties of undefined (reading 'qty')");
check("name and message", describe(e).message, "TypeError: Cannot read properties of undefined (reading 'qty')");
check("the stack goes too", typeof describe(e).stack, "string");
check("a string is itself", describe("boom").message, "boom");
check("a supabase-shaped object is read by its fields", describe({ code: "42501", message: "permission denied" }).message, "42501: permission denied");
check("a long message is cut", describe("x".repeat(9000)).message.length, 500);

console.log("--- the line going down is not a bug ---");
check("Failed to fetch", isTheLine("TypeError: Failed to fetch"), true);
check("Load failed (Safari)", isTheLine("TypeError: Load failed"), true);
check("an abort", isTheLine("AbortError: The operation was aborted"), true);
check("but a real crash is", isTheLine("TypeError: Cannot read properties of undefined"), false);

console.log("--- one report per message per five minutes ---");
const seen = new Map();
check("the first goes", worthSending("TypeError: x is not a function", seen, 1000), true);
check("the same again does not", worthSending("TypeError: x is not a function", seen, 2000), false);
check("a different one does", worthSending("RangeError: y", seen, 2000), true);
check("the first again after the window does", worthSending("TypeError: x is not a function", seen, 1000 + REPEAT_WINDOW_MS + 1), true);
check("the line never does", worthSending("TypeError: Failed to fetch", seen, 5000), false);
check("nor an empty message", worthSending("   ", seen, 5000), false);

console.log("--- the outbox keeps the newest twenty ---");
let box = [];
for (let i = 0; i < 30; i++) box = enqueue(box, { kind: "error", message: `m${i}`, stack: null, url: "/", at: "" });
check("capped", box.length, OUTBOX_MAX);
check("newest kept", box[box.length - 1].message, "m29");
check("oldest dropped", box[0].message, "m10");

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
