/**
 * The nightly line: what the tills reported in the last day, as one email.
 *
 * Pure, so Node can hold it to account (test/digest.test.mjs). index.ts
 * fetches the rows and sends what this makes of them.
 */

export interface ErrorRow { org_id: string; register_id: string; kind: string; message: string; at: string }
export interface QuestionRow { org_id: string; unlocked: boolean; tools: string[] }
export interface Named { id: string; name: string }

export interface Digest {
  subject: string;
  text: string;
  html: string;
  errors: number;
  questions: number;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Nothing to say is null: no email goes out on a quiet night. */
export function summarise(
  errors: ErrorRow[], questions: QuestionRow[], orgs: Named[], regs: Named[], since: Date,
): Digest | null {
  if (errors.length === 0 && questions.length === 0) return null;
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? "a shop";
  const regName = (id: string) => regs.find((r) => r.id === id)?.name ?? "a till";

  // Errors by shop, then the same message counted once per shop with its
  // tills and its last time, most frequent first.
  const byOrg = new Map<string, ErrorRow[]>();
  for (const e of errors) byOrg.set(e.org_id, [...(byOrg.get(e.org_id) ?? []), e]);
  const qByOrg = new Map<string, QuestionRow[]>();
  for (const q of questions) qByOrg.set(q.org_id, [...(qByOrg.get(q.org_id) ?? []), q]);

  const orgIds = [...new Set([...byOrg.keys(), ...qByOrg.keys()])]
    .sort((a, b) => (byOrg.get(b)?.length ?? 0) - (byOrg.get(a)?.length ?? 0));

  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const id of orgIds) {
    const es = byOrg.get(id) ?? [];
    const qs = qByOrg.get(id) ?? [];
    const groups = new Map<string, { n: number; tills: Set<string>; last: string; kind: string }>();
    for (const e of es) {
      const g = groups.get(e.message) ?? { n: 0, tills: new Set<string>(), last: e.at, kind: e.kind };
      g.n += 1;
      g.tills.add(regName(e.register_id));
      if (e.at > g.last) g.last = e.at;
      groups.set(e.message, g);
    }
    const top = [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
    const unlocked = qs.filter((q) => q.unlocked).length;
    const unanswered = qs.filter((q) => q.tools.length === 0).length;

    const head = `${orgName(id)}: ${es.length} error${es.length === 1 ? "" : "s"}, ${qs.length} TillAI question${qs.length === 1 ? "" : "s"}` +
      (qs.length ? ` (${unlocked} unlocked, ${unanswered} answered without a lookup)` : "");
    textParts.push(head);
    htmlParts.push(`<h3>${esc(head)}</h3>`);
    if (top.length) {
      textParts.push(...top.map(([m, g]) => `  ${g.n}× [${g.kind}] ${m} — ${[...g.tills].join(", ")} — last ${g.last.slice(0, 16).replace("T", " ")}Z`));
      htmlParts.push("<table cellpadding=\"4\">" + top.map(([m, g]) =>
        `<tr><td align="right"><b>${g.n}×</b></td><td><code>${esc(g.kind)}</code></td><td>${esc(m)}</td><td>${esc([...g.tills].join(", "))}</td><td>${esc(g.last.slice(0, 16).replace("T", " "))}Z</td></tr>`
      ).join("") + "</table>");
    }
  }

  const shops = orgIds.length;
  const subject = errors.length
    ? `InnovaPOS: ${errors.length} error${errors.length === 1 ? "" : "s"} on ${shops} shop${shops === 1 ? "" : "s"} in the last day`
    : `InnovaPOS: quiet night, ${questions.length} TillAI question${questions.length === 1 ? "" : "s"}`;
  const when = `Since ${since.toISOString().slice(0, 16).replace("T", " ")}Z.`;
  return {
    subject,
    text: [subject, when, "", ...textParts].join("\n"),
    html: `<h2>${esc(subject)}</h2><p>${esc(when)}</p>${htmlParts.join("")}`,
    errors: errors.length,
    questions: questions.length,
  };
}
