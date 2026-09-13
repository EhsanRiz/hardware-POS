/**
 * The invitation SMS, held to its two promises: it is the same words the
 * staff screen shows, and it costs the shop two segments at most.
 *
 * supabase/functions/auth/invite-message.ts has no Deno import so that this
 * file can load it the way tillai.test.mjs loads tools.ts. The GSM 7-bit
 * check matters more than it looks: one character outside the set (an em
 * dash, a curly quote) sends the whole message as UCS-2, which halves the
 * room per segment and doubles the bill for every colleague added.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../supabase/functions/auth/invite-message.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { inviteMessage, DEFAULT_ENROL_URL } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) return;
  failures++;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

// The GSM 03.38 basic set, as the networks count it. Anything else forces
// UCS-2 for the whole message.
const GSM7 = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r]*$/;

const msg = inviteMessage("+27825550100");
check("names the enrolment page", msg.includes(DEFAULT_ENROL_URL), msg);
check("names the number they were added with", msg.includes("+27825550100"), msg);
check("carries no code and no PIN", !/\d{6}/.test(msg.replace("+27825550100", "")), msg);
check("says the PIN is theirs to choose", /choose your own PIN/.test(msg), msg);
check("is GSM 7-bit only", GSM7.test(msg), JSON.stringify(msg));

// The longest number pos_admin_invite_user accepts is + and fifteen digits.
const longest = inviteMessage("+" + "9".repeat(15));
check("fits in two SMS segments at the longest number", longest.length <= 306, String(longest.length));
check("longest is still GSM 7-bit", GSM7.test(longest));

// The page can be pointed elsewhere for a preview build; the words stay.
check("takes the page as given", inviteMessage("+27825550100", "https://x.test/e/").includes("https://x.test/e/"));

if (failures) {
  console.error(`${failures} invite-message check(s) failed`);
  process.exit(1);
}
console.log("invite-message: all checks passed");
