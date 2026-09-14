/**
 * When a phone in somebody's pocket is worth buzzing.
 *
 * These rules are the whole difference between a notification somebody acts
 * on and one they switch off — and switching them off takes the useful ones
 * with it, which is why the bar is this high and held here.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../supabase/functions/push/rules.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = {};
new Function("exports", js)(mod);
const { whatToSay, signature, withinHours } = mod;

let failures = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.error(`FAIL ${label}: got ${a}, wanted ${b}`); }
};

// Mid-morning in the shop (SAST is UTC+2).
const morning = new Date("2026-09-14T08:00:00Z");
const midnight = new Date("2026-09-14T22:10:00Z");
const dawn = new Date("2026-09-14T04:30:00Z");

check("the shop is open mid-morning", withinHours(morning), true);
check("and is not at ten past midnight", withinHours(midnight), false);
check("nor at half past six", withinHours(dawn), false);

// A customer standing at a counter, and nothing said about it yet.
check("the first sale waiting is worth a buzz",
  whatToSay({ approvals: 1, deliveries_late: 0 }, null, morning)?.body,
  "1 sale is waiting for a manager");
check("and both kinds arrive as one line",
  whatToSay({ approvals: 2, deliveries_late: 1 }, null, morning)?.body,
  "2 sales are waiting for a manager · 1 delivery should already have gone");

// Said once. The cron runs every few minutes and must not say it again.
check("the same news is not sent twice",
  whatToSay({ approvals: 1, deliveries_late: 0 }, "a1d0", morning), null);
check("but one more sale is news",
  whatToSay({ approvals: 2, deliveries_late: 0 }, "a1d0", morning)?.body,
  "2 sales are waiting for a manager");
// Going down is progress, and progress does not buzz.
check("one fewer is not news",
  whatToSay({ approvals: 1, deliveries_late: 0 }, "a2d0", morning), null);
check("and neither is the last one being dealt with",
  whatToSay({ approvals: 0, deliveries_late: 0 }, "a2d0", morning), null);

// A late delivery appears by itself at midnight, when today's becomes
// yesterday's. That must not wake anybody.
check("nothing is sent at night, however much has piled up",
  whatToSay({ approvals: 3, deliveries_late: 4 }, null, midnight), null);
check("it waits for the morning",
  whatToSay({ approvals: 3, deliveries_late: 4 }, null, morning)?.body,
  "3 sales are waiting for a manager · 4 deliveries should already have gone");

// One notification per phone, replaced rather than stacked.
check("the tag is the same every time",
  whatToSay({ approvals: 1, deliveries_late: 0 }, null, morning)?.tag,
  "innovapos-needs-you");
// And nothing about money on a lock screen.
const said = whatToSay({ approvals: 1, deliveries_late: 2 }, null, morning);
check("the title says only which app it is", said.title, "InnovaPOS");
check("what is recorded as sent is what was waiting", said.signature, "a1d2");
check("which is the same string the signature makes",
  signature({ approvals: 1, deliveries_late: 2 }), "a1d2");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("push rules: all checks passed");
