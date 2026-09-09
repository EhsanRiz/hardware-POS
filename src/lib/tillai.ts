import { API_BASE } from "./supabase";
import { requireToken } from "./api";

/**
 * A question for TillAI, answered on the server from this shop's records.
 *
 * The till sends its register token, the question and the last few turns,
 * and gets back the words and a list of what was looked at. Everything the
 * assistant may read is decided on the server (supabase/functions/tillai);
 * nothing here can widen it. It needs the line — there is no offline answer,
 * and the caller says so rather than trying.
 */
export interface TillAITurn {
  role: "user" | "model";
  text: string;
}

export interface TillAIAnswer {
  answer: string;
  lookedAt: string[];
}

export async function askTillAI(question: string, history: TillAITurn[]): Promise<TillAIAnswer> {
  const res = await fetch(`${API_BASE}/functions/v1/tillai`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ register_token: requireToken(), question, history }),
  });
  let out: { ok?: boolean; answer?: string; looked_at?: string[]; message?: string } = {};
  try {
    out = await res.json();
  } catch {
    /* a proxy or a dropped line can answer with something that is not JSON */
  }
  if (!res.ok || !out.ok || typeof out.answer !== "string") {
    throw new Error(out.message ?? "TillAI could not answer just now.");
  }
  return { answer: out.answer, lookedAt: out.looked_at ?? [] };
}
