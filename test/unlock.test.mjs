/**
 * How long a proved PIN lasts.
 *
 * The doors (Manage, the stock room) used to forget the PIN the moment their
 * screen closed, so working through the back office meant typing it again and
 * again. Now it is held for a while — and "a while" is the whole security
 * argument, so it is worth holding to the clock rather than to a click.
 *
 * src/lib/unlock.ts keeps no React and no storage, which is what lets this
 * drive it directly with the time it likes.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/unlock.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// The real rules, near enough: role "admin" holds everything, everybody else
// holds what they were granted — which is what effective_permissions returns.
const stubs = {
  "./permissions": {
    can: (u, p) => !!u && (u.role === "admin" || (u.permissions ?? []).includes(p)),
    canAny: (u, ps) => ps.some((p) => stubs["./permissions"].can(u, p)),
  },
};
const unlock = {};
new Function("exports", "require", js)(unlock, (m) => stubs[m] ?? {});
const { remember, recall, forgetPins, pinProved } = unlock;

let now = 1_700_000_000_000;
Date.now = () => now;
const MINUTE = 60_000;

let failures = 0;
const check = (label, got, want) => {
  if (got !== want) {
    failures++;
    console.error(`FAIL ${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
};

// Proved, and good straight away.
remember("admin", "123456");
check("a PIN just proved opens the door", recall("admin"), "123456");
check("and the other door is not opened by it", recall("stock"), null);

// Nine minutes later it is still good, and asking rolls the clock on.
now += 9 * MINUTE;
check("nine minutes on, still good", recall("admin"), "123456");
now += 9 * MINUTE;
check("nine more, because using it kept it", recall("admin"), "123456");

// Left alone past the window, it is gone.
now += 11 * MINUTE;
check("left alone for eleven minutes, the door is shut", recall("admin"), null);
check("and it stays shut", recall("admin"), null);

// Signing out takes everything.
remember("admin", "123456");
remember("stock", "123456");
forgetPins();
check("signing out forgets the back office", recall("admin"), null);
check("and the stock room", recall("stock"), null);

// A phone's owner opens the doors their permissions reach, and no others.
const manager = { role: "admin", permissions: [] };
pinProved(manager, "123456", "personal");
check("a manager's own PIN opens the back office", recall("admin"), "123456");
check("and the stock room", recall("stock"), "123456");

forgetPins();
const counterHand = { role: "employee", permissions: ["take_payments", "apply_discount"] };
pinProved(counterHand, "567890", "personal");
check("somebody with only the counter opens neither: back office", recall("admin"), null);
check("somebody with only the counter opens neither: stock room", recall("stock"), null);

forgetPins();
const storeman = { role: "employee", permissions: ["take_payments", "manage_inventory"] };
pinProved(storeman, "111111", "personal");
check("the storeman's PIN opens the stock room", recall("stock"), "111111");

// A SHARED TILL KEEPS ONE DOOR AND DROPS THE OTHER.
//
// Reported from the counter as "too many PIN requirements". Signing in proves
// the PIN against the server; asking for the identical six digits at the stock
// room ninety seconds later proves nothing except that the app was not paying
// attention. The back office is the exception the shop asked for — it is the
// room with the takings, the staff and the settings in it — and on a till it
// still asks. What protects an unattended till is the idle lock, not these.
forgetPins();
pinProved(manager, "123456", "till");
check("on a till the stock room opens on the sign-in", recall("stock"), "123456");
check("but the back office still asks", recall("admin"), null);

// The same manager on their own phone: nobody else is holding it.
forgetPins();
pinProved(manager, "123456", "personal");
check("on a phone the back office opens too", recall("admin"), "123456");

// Permissions are untouched by any of this. Somebody who may not count stock
// does not get the stock room because the device is a till.
forgetPins();
pinProved(counterHand, "567890", "till");
check("a counter hand still opens no stock room on a till", recall("stock"), null);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("unlock: all checks passed");
