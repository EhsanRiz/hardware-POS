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
// The title is what a locked phone shows in bold, so it carries the news —
// the app's own name is already above it, twice on iOS.
check("the first sale waiting is worth a buzz",
  whatToSay({ approvals: 1, deliveries_late: 0 }, null, morning)?.title,
  "1 sale is waiting for a manager");
check("with nothing trailing after it",
  whatToSay({ approvals: 1, deliveries_late: 0 }, null, morning)?.body, "");

// Which shop, under the news: somebody who helps at two of them needs to know
// before they put their boots on. The name is over the door; it is not a
// figure out of the till.
check("the shop says which shop it is",
  whatToSay({ approvals: 1, deliveries_late: 0 }, null, morning, "Ladybrand Hardware")?.body,
  "Ladybrand Hardware");
check("and it follows the other thing waiting rather than replacing it",
  whatToSay({ approvals: 1, deliveries_late: 2 }, null, morning, "Ladybrand Hardware")?.body,
  "2 deliveries should already have gone · Ladybrand Hardware");
check("a shop with no name set leaves no stray separator",
  whatToSay({ approvals: 1, deliveries_late: 2 }, null, morning, "   ")?.body,
  "2 deliveries should already have gone");
check("and when two things wait, the more urgent is the title",
  whatToSay({ approvals: 2, deliveries_late: 1 }, null, morning)?.title,
  "2 sales are waiting for a manager");
check("and the other is under it",
  whatToSay({ approvals: 2, deliveries_late: 1 }, null, morning)?.body,
  "1 delivery should already have gone");
// A late load on its own is the title, not a body with an empty heading.
check("a load that should have gone stands on its own",
  whatToSay({ approvals: 0, deliveries_late: 1 }, null, morning)?.title,
  "1 delivery should already have gone");

// Said once. The cron runs every few minutes and must not say it again.
check("the same news is not sent twice",
  whatToSay({ approvals: 1, deliveries_late: 0 }, "a1d0", morning), null);
check("but one more sale is news",
  whatToSay({ approvals: 2, deliveries_late: 0 }, "a1d0", morning)?.title,
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
  whatToSay({ approvals: 3, deliveries_late: 4 }, null, morning)?.title,
  "3 sales are waiting for a manager");

// One notification per phone, replaced rather than stacked.
check("the tag is the same every time",
  whatToSay({ approvals: 1, deliveries_late: 0 }, null, morning)?.tag,
  "innovapos-needs-you");
// And nothing about money on a lock screen.
const said = whatToSay({ approvals: 1, deliveries_late: 2 }, null, morning);
// No money on a lock screen. Case-sensitive on purpose: a lower-case "r
// 2" appears inside "manager 2", and an assertion that fires on that is an
// assertion nobody will trust the next time it goes red.
check("no figure from the till is on the lock screen",
  /\bR\s?\d/.test(`${said.title} ${said.body}`), false);
check("what is recorded as sent is what was waiting", said.signature, "a1d2");
check("which is the same string the signature makes",
  signature({ approvals: 1, deliveries_late: 2 }), "a1d2");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("push rules: all checks passed");
