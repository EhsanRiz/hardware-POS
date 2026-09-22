#!/usr/bin/env node
/**
 * The last thing between a slip and a shop that cannot trade.
 *
 * Claude runs SQL against this shop's live database without stopping to ask —
 * that is deliberate and it is in .claude/settings.json. What it buys in speed
 * it gives up in checkpoints, and the checkpoint it gave up was the only thing
 * standing in front of the one class of statement that cannot be undone.
 *
 * This is not a security boundary and could not be one. Anything with a mind
 * to evade it can: split the statement, build it from pieces, hide it behind a
 * function. It is a seatbelt against a mistake made quickly, which is the
 * failure that actually happens — 0107 was very nearly applied in an order
 * that would have made a column NOT NULL while the old code was still writing
 * nulls, and every sale at the counter would have been refused. That was
 * caught by reading. This catches the ones nobody re-reads.
 *
 * WHAT IT REFUSES, and why each one and not more:
 *
 *   DROP TABLE / SCHEMA / DATABASE   The data is gone. No migration in this
 *   TRUNCATE                         repository has ever needed one.
 *
 *   UPDATE or DELETE with no WHERE   Every row at once. Almost always a
 *   (execute_sql only)               forgotten clause rather than an intent.
 *
 * WHAT IT DELIBERATELY ALLOWS, because refusing it would break the repository's
 * own documented practice:
 *
 *   DROP FUNCTION                    CLAUDE.md REQUIRES it. "Adding a defaulted
 *                                    argument creates a NEW function signature
 *                                    ... Always drop function if exists with
 *                                    the old argument list first. This has
 *                                    bitten twice." A guard that forbade it
 *                                    would push people around it.
 *
 *   Unbounded UPDATE in a MIGRATION  A backfill over every row is what a
 *                                    migration is for. Migrations are numbered,
 *                                    reviewed and in git; ad-hoc SQL is none of
 *                                    those, so the two are held to different
 *                                    rules on purpose.
 *
 * IT FAILS CLOSED. If this script itself breaks, it refuses rather than waves
 * things through: a guard that silently stops guarding is worse than no guard,
 * because the confidence stays behind after the protection has gone. A refusal
 * is loud, immediate, and gets fixed in a minute.
 */

const CATASTROPHIC = [
  [/\bdrop\s+table\b/, "DROP TABLE"],
  [/\bdrop\s+schema\b/, "DROP SCHEMA"],
  [/\bdrop\s+database\b/, "DROP DATABASE"],
  [/\btruncate\b/, "TRUNCATE"],
];

/**
 * Comments and string literals out, whitespace flattened.
 *
 * Both matter for the same reason: a DROP TABLE inside a comment is not a
 * statement, and the words "delete from" inside a customer's note are not
 * either. Matching raw text would refuse an innocent query and teach whoever
 * hit it that the guard is noise.
 */
function strip(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // /* block comments */
    .replace(/--[^\n]*/g, " ")           // -- line comments
    .replace(/'(?:[^']|'')*'/g, " '' ")  // 'string literals', '' escapes and all
    .replace(/\$\$[\s\S]*?\$\$/g, " $$ ") // $$ function bodies $$
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * An UPDATE or DELETE that names no rows.
 *
 * Checked per statement, not over the whole script: "delete from a where x;
 * delete from b;" has a WHERE in it and is still a mistake in its second half.
 */
function unboundedWrites(clean) {
  const found = [];
  for (const stmt of clean.split(";")) {
    const s = stmt.trim();
    if (!s) continue;
    const isDelete = /^delete\s+from\b/.test(s);
    const isUpdate = /^update\b/.test(s);
    if (!isDelete && !isUpdate) continue;
    // A CTE or a sub-select can carry the WHERE; this only asks whether the
    // statement constrains anything at all, which is the mistake being caught.
    if (!/\bwhere\b/.test(s)) {
      found.push(isDelete ? "DELETE with no WHERE" : "UPDATE with no WHERE");
    }
  }
  return found;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let tool, sql;
  try {
    const input = JSON.parse(raw || "{}");
    tool = input.tool_name ?? "";
    sql = String(input.tool_input?.query ?? "");
  } catch (e) {
    // Fails closed, on purpose. See the note at the top.
    deny(`The SQL guard could not read this call (${e.message}), so it refused `
       + `it. Fix .claude/hooks/guard-sql.mjs rather than working around it.`);
    return;
  }

  if (!sql.trim()) process.exit(0);
  const clean = strip(sql);
  const hits = [];

  for (const [re, name] of CATASTROPHIC) if (re.test(clean)) hits.push(name);

  // Only ad-hoc SQL. A migration is allowed to rewrite every row of a table —
  // that is what a backfill is — and it arrives reviewed and in git.
  if (tool.endsWith("execute_sql")) hits.push(...unboundedWrites(clean));

  if (hits.length === 0) process.exit(0);

  deny(
    `Refused by the repository's SQL guard: ${[...new Set(hits)].join(", ")}.\n\n`
    + `This runs against the shop's LIVE database with no prompt in front of `
    + `it, so the statements that cannot be undone are refused here instead.\n\n`
    + `If it is genuinely meant: say so to the person you are working with and `
    + `let them run it, or narrow the statement (add a WHERE, name the rows). `
    + `Do not route around the guard.\n\n`
    + `The rules are in .claude/hooks/guard-sql.mjs and DROP FUNCTION is `
    + `allowed on purpose — CLAUDE.md requires it for migrations.`
  );
});
