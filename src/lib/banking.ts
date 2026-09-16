/**
 * Where to pay, as a document prints it.
 *
 * A shop keeps more than one account and here that is not filing: an EFT
 * within a bank clears the same day and between banks it does not, so a
 * customer who can see their own bank on the invoice pays the shop sooner.
 * The block is therefore a list of accounts, not a set of four fields.
 *
 * One function because there are four places that print it — the till slip,
 * the A4 sheet on screen, the PDF of that sheet, and a statement's PDF — and
 * four copies of "which of these lines are filled in" is four chances for a
 * shop's second account to appear on three of them.
 */
import type { ShopSettings } from "./types";

/**
 * One list of label/value rows per account, blanks dropped.
 *
 * An account with nothing filled in yields no rows and is left out, so an
 * empty account never prints a heading with nothing under it.
 */
export function bankingRows(s: ShopSettings): [string, string][][] {
  return (s.bank_accounts ?? [])
    .map((a) =>
      ([
        ["Bank", a.bank_name],
        ["Account name", a.account_name],
        ["Account no", a.account_number],
        ["Branch code", a.branch_code],
      ] as [string, string | null | undefined][])
        .filter(([, v]) => (v ?? "").trim() !== "") as [string, string][]
    )
    .filter((rows) => rows.length > 0);
}
