// Reading a supplier's document, so nobody types what the page already says.
//
// A quotation carries the supplier's name, VAT number and phone on the
// letterhead, its own number and date, and every line with a code, a
// description, a quantity and a price. Typing that into a form is twenty
// minutes and a transposed digit. This hands the pages to Gemini and gets it
// back as data, which the manager then confirms on one screen.
//
// Nothing is written here. The function reads and answers; the client shows
// the answer for confirmation and the filing is a separate, ordinary RPC.
// That is deliberate — a model's reading of a photograph is a suggestion, and
// a suggestion must not become a record without a person seeing it.
//
// The key lives in this function's environment (GEMINI_API_KEY) and is never
// in the browser. Gated on manage_purchasing like the rest of the drawer.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Overridable without a redeploy, because model names outlive nothing.
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
const ENDPOINT = (m: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

/** Eight pages of a delivery note is a long delivery note. */
const MAX_PAGES = 12;
const MAX_BYTES_PER_PAGE = 10 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

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

// What we want back. Given to the model as a schema rather than asked for in
// prose: a free-text answer has to be parsed, and a parser for prose is a
// source of bugs nobody wants at a trade counter.
const SCHEMA = {
  type: "object",
  properties: {
    supplier_name: { type: "string" },
    supplier_vat: { type: "string" },
    supplier_phone: { type: "string" },
    supplier_email: { type: "string" },
    supplier_address: { type: "string" },
    bank_name: { type: "string" },
    bank_account_name: { type: "string" },
    bank_account_number: { type: "string" },
    bank_branch_code: { type: "string" },
    kind: { type: "string", enum: ["quote", "invoice", "delivery_note", "statement", "other"] },
    doc_number: { type: "string" },
    doc_date: { type: "string" },
    subtotal: { type: "number" },
    tax_total: { type: "number" },
    total: { type: "number" },
    currency: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          supplier_code: { type: "string" },
          description: { type: "string" },
          qty: { type: "number" },
          unit_price: { type: "number" },
          line_total: { type: "number" },
        },
        required: ["description"],
      },
    },
  },
  required: ["kind", "lines"],
};

const PROMPT = `You are reading a document a hardware shop received from one of its SUPPLIERS: a quotation, invoice, delivery note or statement.

Return the supplier's own details from the letterhead — NOT the customer's. The customer here is the hardware shop the document is addressed to; ignore its name, address, VAT number and banking entirely. The supplier is the business that issued the document, usually at the top or in the letterhead.

supplier_address is the supplier's street address as printed, on one line, comma separated: "25 Birmingham Road, Benoni South, 1502".

The banking is usually at the foot of the page, under a heading like BANKING DETAILS. bank_name is the bank ("FNB", "Standard Bank"), bank_account_name the name the account is held in, bank_account_number the account number, bank_branch_code the branch or universal code. Give digits only for the account and branch numbers. If the page shows no banking, leave those fields out.

For every priced or listed item row, return one line with:
- supplier_code: the supplier's stock/product code for that row, if the row has one
- description: the item description as printed
- qty: the quantity ordered or delivered
- unit_price: the price of ONE unit, as printed
- line_total: the total for that row, as printed

Rules:
- Numbers must be plain numbers: 5300.35, never "R 5 300.35" or "5,300.35".
- doc_date must be YYYY-MM-DD. A South African document may print 2026/08/13 or 13/08/2026; both are 13 August 2026.
- Do not compute, correct or reconcile anything. Report what is printed. If a figure is not on the page, leave the field out rather than guessing.
- Skip header rows, subtotal rows, totals, banking details and terms; those are not item lines.
- If the document runs to several pages, read them all as one document.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  if (!API_KEY) {
    return json({ ok: false, message: "No reading key is configured for this shop." }, 503);
  }

  let b: { register_token?: string; pin?: string; pages?: { mime: string; data: string }[] };
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request" }, 400);
  }

  const token = b.register_token ?? "";
  const pin = b.pin ?? "";
  const pages = b.pages ?? [];
  if (!token || !pin) return json({ ok: false, message: "Missing details" }, 400);
  if (pages.length === 0) return json({ ok: false, message: "No pages to read" }, 400);
  if (pages.length > MAX_PAGES) {
    return json({ ok: false, message: `That is more than ${MAX_PAGES} pages` }, 413);
  }
  for (const p of pages) {
    if (!ALLOWED.includes(p.mime)) {
      return json({ ok: false, message: "Use photos (JPEG, PNG, WebP) or a PDF" }, 400);
    }
    // base64 is four characters for every three bytes.
    if ((p.data?.length ?? 0) * 0.75 > MAX_BYTES_PER_PAGE) {
      return json({ ok: false, message: "One of those pages is too large" }, 413);
    }
  }

  // May this till, with this PIN, do the buying for this shop?
  const { data: orgId, error: permError } = await supabase.rpc("pos_admin_org_for", {
    p_register_token: token,
    p_pin: pin,
    p_perm: "manage_purchasing",
  });
  if (permError || !orgId) {
    return json({ ok: false, message: permError?.message ?? "Not permitted" }, 403);
  }

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: PROMPT },
        ...pages.map((p) => ({ inlineData: { mimeType: p.mime, data: p.data } })),
      ],
    }],
    generationConfig: {
      // Reading, not writing: the same page must give the same answer twice.
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  };

  const call = (model: string) =>
    fetch(ENDPOINT(model), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify(body),
    });

  let model = MODEL;
  let res: Response;
  try {
    res = await call(model);
  } catch (e) {
    console.error(e);
    return json({ ok: false, message: "Could not reach the reading service" }, 502);
  }

  // A model name outlives nothing. When one is retired the API answers 404 and
  // names its replacement in the same breath — so follow it once rather than
  // telling a shop in Ladybrand to type in a thirteen-line quotation because
  // Google renamed something. GEMINI_MODEL still overrides, and the swap is
  // logged so it is a fact somebody can see rather than a mystery.
  if (res.status === 404) {
    const detail = await res.text().catch(() => "");
    const named = /models\/([A-Za-z0-9._-]+)/g;
    const suggested = [...detail.matchAll(named)]
      .map((m) => m[1])
      .find((m) => m !== model);
    if (suggested) {
      console.log(`gemini: ${model} is gone, trying ${suggested}`);
      model = suggested;
      try {
        res = await call(model);
      } catch (e) {
        console.error(e);
        return json({ ok: false, message: "Could not reach the reading service" }, 502);
      }
    } else {
      console.error("gemini 404", detail.slice(0, 500));
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("gemini", res.status, detail.slice(0, 500));
    // The shop does not need the provider's wording; it needs to know whether
    // to try again or to type it in.
    const message = res.status === 429
      ? "The reading service is busy. Try again in a moment, or type the details in."
      : "The pages could not be read. File them and type the details in.";
    return json({ ok: false, message }, 502);
  }

  let out: Record<string, unknown>;
  try {
    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    out = JSON.parse(text);
  } catch (e) {
    console.error(e);
    return json({ ok: false, message: "The reading came back unreadable" }, 502);
  }

  return json({ ok: true, read: out, model });
});
