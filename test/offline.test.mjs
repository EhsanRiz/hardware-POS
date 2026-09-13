/**
 * The probe's patience: what one result means for the till's state.
 *
 * A six-second timeout once turned every stall on the shop's line into an
 * "offline" banner while the sales beside it went through. judge() is the
 * rule that decides, kept pure in src/lib/offline.ts so this can hold it.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/offline.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const stubs = {
  react: { useEffect: () => {}, useState: (v) => [v, () => {}] },
  "./errors": { errorMessage: () => "", errorName: () => "" },
  "./supabase": { API_BASE: "https://x.test/api" },
};
const exports_ = {};
new Function("exports", "require", js)(exports_, (m) => stubs[m] ?? {});
const { judge } = exports_;

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`FAIL ${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
};

check("one miss on a slow line is not an outage, and is re-checked soon",
  judge({ online: true, misses: 0 }, "miss", false), { online: true, misses: 1, retrySoon: true });
check("the second miss in a row is",
  judge({ online: true, misses: 1 }, "miss", false), { online: false, misses: 2, retrySoon: false });
check("one miss when the browser itself says no network is enough",
  judge({ online: true, misses: 0 }, "miss", true), { online: false, misses: 1, retrySoon: false });
check("a success clears the misses and puts the till back at once",
  judge({ online: false, misses: 4 }, "ok", false), { online: true, misses: 0, retrySoon: false });
check("a success while online is a no-op",
  judge({ online: true, misses: 0 }, "ok", false), { online: true, misses: 0, retrySoon: false });
check("while offline, a further miss stays offline without a hurried retry",
  judge({ online: false, misses: 2 }, "miss", false), { online: false, misses: 3, retrySoon: false });

if (failures) { console.error(`${failures} offline check(s) failed`); process.exit(1); }
console.log("offline: all checks passed");
