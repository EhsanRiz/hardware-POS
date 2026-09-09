/**
 * TillAI: a question about the shop, answered from the shop's own records.
 *
 * The till sends the register token, the question and the last few turns.
 * This function proves the token, asks Gemini what to look up, runs the
 * lookups it asks for — through the same token-only RPCs the till itself
 * calls, so the shop's isolation applies to the assistant exactly as it does
 * to the counter — hands back only the allowlisted columns, and returns the
 * model's words with a list of what it looked at.
 *
 * Runs as an edge function because the Gemini key lives here and a daily
 * cap needs a place to count. The anon key can call this, so the token is
 * proved before anything else happens, and a bad one is refused in the same
 * words the RPCs use.
 *
 * What the model may touch is decided in tools.ts, which is pure and tested
 * with Node. Nothing here adds a tool.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  DAILY_CAP, HISTORY_TURNS, MAX_QUESTION, MAX_ROUNDS,
  declarations, scrub, systemPrompt, toolNamed,
} from "./tools.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Overridable without a redeploy, because model names outlive nothing.
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
const ENDPOINT = (m: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Turn { role: "user" | "model"; text: string }
type Part = Record<string, unknown>;
interface Content { role: "user" | "model"; parts: Part[] }

/** One call to the model; a retired model name is followed once, as the document reader does. */
async function generate(body: unknown): Promise<{ res: Response; model: string }> {
  let model = MODEL;
  const call = (m: string) =>
    fetch(`${ENDPOINT(m)}?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  let res = await call(model);
  if (res.status === 404) {
    const detail = await res.text().catch(() => "");
    const suggested = [...detail.matchAll(/models\/([A-Za-z0-9._-]+)/g)]
      .map((m) => m[1]).find((m) => m !== model);
    if (suggested) {
      console.log(`gemini: ${model} is gone, trying ${suggested}`);
      model = suggested;
      res = await call(model);
    }
  }
  return { res, model };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  let body: { register_token?: string; question?: string; history?: Turn[]; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request" }, 400);
  }

  const token = String(body.register_token ?? "");
  const question = String(body.question ?? "").trim().slice(0, MAX_QUESTION);
  // The person's PIN, if they unlocked TillAI. It goes only to PIN-checked
  // RPCs, which decide what it opens; it is never logged and never shown to
  // the model.
  const pin = /^\d{4,8}$/.test(String(body.pin ?? "")) ? String(body.pin) : null;
  if (!token) return json({ ok: false, message: "Register not paired or revoked" }, 403);
  if (!question) return json({ ok: false, message: "Ask something first." }, 400);

  // The token, proved the way the RPCs prove it: by its hash, against an
  // active till. This is what ties every lookup below to one shop.
  const { data: reg } = await supabase
    .from("registers")
    .select("id, org_id, name, active")
    .eq("token_hash", await sha256(token))
    .maybeSingle();
  if (!reg || !reg.active) {
    return json({ ok: false, message: "Register not paired or revoked" }, 403);
  }

  // Flash is cheap, not free, and a shop's line is a shop's bill. The cap is
  // per shop per day, counted from the log this function keeps.
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await supabase
    .from("tillai_questions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", reg.org_id)
    .gte("asked_at", dayAgo);
  if ((count ?? 0) >= DAILY_CAP) {
    return json({ ok: false, message: "TillAI has answered a lot today. It will be back tomorrow." }, 429);
  }

  const { data: org } = await supabase
    .from("organizations").select("name").eq("id", reg.org_id).maybeSingle();

  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => t && (t.role === "user" || t.role === "model") && typeof t.text === "string")
    .slice(-HISTORY_TURNS);
  const contents: Content[] = [
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text.slice(0, 2000) }] })),
    { role: "user", parts: [{ text: question }] },
  ];
  const request = {
    systemInstruction: { parts: [{ text: systemPrompt({ name: org?.name ?? "this shop", till: reg.name }, new Date(), pin !== null) }] },
    tools: [{ functionDeclarations: declarations(pin !== null) }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
    contents,
  };

  const lookedAt: string[] = [];
  let answer = "";
  let model = MODEL;

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const out = await generate(request);
      model = out.model;
      if (!out.res.ok) {
        const detail = await out.res.text().catch(() => "");
        console.error("gemini", out.res.status, detail.slice(0, 500));
        const message = out.res.status === 429
          ? "TillAI is busy. Try again in a moment."
          : "TillAI could not answer just now. The till is fine; try again in a moment.";
        return json({ ok: false, message }, 502);
      }
      const data = await out.res.json();
      const parts: Part[] = data?.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall);
      if (calls.length === 0 || round === MAX_ROUNDS) {
        answer = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();
        break;
      }

      // The model asked for lookups. Each goes through the tool table — an
      // unknown name gets an error back, not a free RPC — and every result is
      // scrubbed to its allowlist before the model sees it.
      const responses: Part[] = [];
      for (const p of calls) {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        const tool = toolNamed(fc.name);
        if (!tool || (tool.pin && pin === null)) {
          responses.push({ functionResponse: { name: fc.name, response: { error: "No such tool" } } });
          continue;
        }
        const { data: rows, error } = await supabase.rpc(tool.rpc, {
          p_register_token: token,
          ...(tool.pin ? { p_pin: pin } : {}),
          ...tool.args(fc.args ?? {}),
        });
        let result: unknown = error ? { error: error.message } : rows;
        if (!error && tool.filter) result = tool.filter(rows, fc.args?.query);
        if (!error) result = scrub(tool, result);
        if (!lookedAt.includes(tool.label)) lookedAt.push(tool.label);
        responses.push({ functionResponse: { name: fc.name, response: { result } } });
      }
      contents.push({ role: "model", parts: calls });
      contents.push({ role: "user", parts: responses });
    }
  } catch (e) {
    console.error(e);
    return json({ ok: false, message: "TillAI could not answer just now. The till is fine; try again in a moment." }, 502);
  }

  if (!answer) answer = "I could not find an answer to that in the shop's records.";

  // The log is the cap's counter and the shop's own record of what was asked.
  await supabase.from("tillai_questions").insert({
    org_id: reg.org_id,
    register_id: reg.id,
    question,
    tools: lookedAt,
    answer: answer.slice(0, 4000),
    model,
    unlocked: pin !== null,
  });

  return json({ ok: true, answer, looked_at: lookedAt });
});
