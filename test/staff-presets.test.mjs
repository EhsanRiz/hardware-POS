/**
 * What each job can actually do.
 *
 * A role and sixteen boxes is the truth, and it is also sixteen chances to get
 * somebody's Friday wrong. The presets are the sets a shop hires into — so
 * what is checked here is not that the lists match, but what a person in each
 * job may DO once the role's own permissions and the ticked extras are added
 * together. That sum is the thing a shopkeeper would recognise.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/permissions.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = {};
new Function("exports", js)(mod);
const { STAFF_PRESETS, ROLE_DEFAULTS, ALL_PERMS, ROLE_TITLE } = mod;

let failures = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.error(`FAIL ${label}: got ${a}, wanted ${b}`); }
};

const preset = (key) => STAFF_PRESETS.find((p) => p.key === key);
/** Everything this job ends up holding: the role's own set plus the extras. */
const holds = (key) => {
  const p = preset(key);
  return new Set([...ROLE_DEFAULTS[p.role], ...p.extras]);
};
const can = (key, perm) => holds(key).has(perm);

// The whole reason the Helper role exists. On Counter these three would carry
// take_payments however few boxes were ticked, because the boxes only add.
check("a driver cannot take money", can("driver", "take_payments"), false);
check("nor can a storeman", can("storeman", "take_payments"), false);
check("and a driver holds nothing whatsoever", holds("driver").size, 0);

// And the counter still is the counter.
check("a cashier takes payment", can("cashier", "take_payments"), true);
check("and may discount", can("cashier", "apply_discount"), true);
check("but may not approve their own", can("cashier", "approve_discount"), false);
check("nor take goods back", can("cashier", "void_refund"), false);

// The supervisor exists to stop a manager being fetched to the counter.
check("a supervisor approves a discount", can("supervisor", "approve_discount"), true);
check("and takes goods back", can("supervisor", "void_refund"), true);
// Deliberately separate from manage_catalogue: fixing a barcode is not being
// shown the shop's margins.
check("but is not shown what the shop pays", can("supervisor", "view_cost_prices"), false);
check("and cannot see the reports", can("supervisor", "view_reports"), false);

// The stock room, and only the stock room.
check("a storeman receives goods", can("storeman", "manage_inventory"), true);
check("and photographs the shelf", can("storeman", "shelf_capture"), true);
check("without being shown a cost price", can("storeman", "view_cost_prices"), false);

// Nobody below Manager buys. Ordering from suppliers is the manager's job in a
// shop this size, and they already hold it.
check("no job below manager orders from suppliers",
  ["cashier", "supervisor", "storeman", "driver"].filter((k) => can(k, "manage_purchasing")), []);
check("and none of them is shown what the shop pays",
  ["cashier", "supervisor", "storeman", "driver"].filter((k) => can(k, "view_cost_prices")), []);

// Nobody but the owner administers the shop.
for (const key of ["cashier", "supervisor", "storeman", "driver", "manager"]) {
  check(`${key} cannot manage staff`, can(key, "manage_staff"), false);
  check(`${key} cannot change the shop's settings`, can(key, "manage_settings"), false);
}
check("the owner can", can("owner", "manage_staff") && can("owner", "manage_settings"), true);

// A preset naming a permission that does not exist would be silently dropped
// by the server and leave somebody unable to do their job, with nothing said.
for (const p of STAFF_PRESETS) {
  const unknown = p.extras.filter((e) => !ALL_PERMS.includes(e));
  check(`${p.key} names only real permissions`, unknown, []);
}
check("every preset names a role that exists",
  STAFF_PRESETS.filter((p) => !(p.role in ROLE_TITLE)).map((p) => p.key), []);
// Two presets that are the same set are two buttons doing one thing, and the
// picker could not tell which one is lit.
const shapes = STAFF_PRESETS.map((p) => `${p.role}:${[...p.extras].sort().join()}`);
check("no two jobs are the same job", shapes.length, new Set(shapes).size);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("staff presets: all checks passed");
