/**
 * Emailing a document, and the one hard limit on it.
 *
 * A `mailto:` link cannot carry an attachment. No browser allows it, and no
 * amount of encoding gets round it — which is why the quote that went out
 * before arrived as the 48-column till slip pasted into the body of the
 * message. So the file is made first, and then one of two things happens:
 *
 *   - the device can share files (a phone, an iPad, Safari on a Mac): the
 *     share sheet opens with the PDF already attached, and Mail is one tap
 *     down it. Nothing else needed.
 *   - it cannot (Chrome and Firefox on a desktop): the PDF is saved to the
 *     machine and the mail app opens with the document in the body, for the
 *     person to attach the file that has just landed in their downloads.
 *
 * The second is two steps, and it is as close as a browser gets. Saying so in
 * the message beats pretending the attachment is there.
 */
import { sheetAsPdf, sheetFileName } from "./pdf";
import { SHEET_TITLE, sheetAsText, type Sheet } from "./sheet";
import type { ShopSettings } from "./types";

export function sheetPdfFile(sheet: Sheet, s: ShopSettings): File {
  return new File([sheetAsPdf(sheet, s)], sheetFileName(sheet), {
    type: "application/pdf",
  });
}

/**
 * Whether this device can hand the file to a mail app itself.
 *
 * Asked synchronously, inside the click, because `navigator.share` needs the
 * gesture and because the answer decides whether to let a `mailto:` link
 * follow through.
 */
export function canShareFile(file: File): boolean {
  return typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });
}

/** Down to the device, under the document's own name. */
export function saveFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the download to start; the object would otherwise be held
  // for the life of the page.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function sheetSubject(sheet: Sheet, s: ShopSettings): string {
  return `${SHEET_TITLE[sheet.kind]} ${sheet.number} from ${s.shop_name}`;
}

/**
 * The draft that opens when the PDF could not be attached for them. The
 * document is still in the body — a customer who only reads it on a phone
 * should not have to open an attachment to see the price.
 */
export function sheetMailto(sheet: Sheet, s: ShopSettings): string {
  const body =
    `${sheetAsText(sheet, s)}\n\n` +
    `A PDF of this ${SHEET_TITLE[sheet.kind].toLowerCase()} ` +
    `(${sheetFileName(sheet)}) has been saved to this device — ` +
    `attach it to this message to send the printed version.` +
    (s.email ? `\n\nReplies: ${s.email}` : "");
  return (
    `mailto:?subject=${encodeURIComponent(sheetSubject(sheet, s))}` +
    `&body=${encodeURIComponent(body)}`
  );
}

export type SendOutcome = "shared" | "saved";

/**
 * One click on Email. Returns how it went, or null when the browser should be
 * left to follow the `mailto:` link itself — the caller passes the click so
 * that can be decided before the navigation starts.
 */
export function emailSheet(
  sheet: Sheet,
  s: ShopSettings,
  onDone: (how: SendOutcome) => void
): { attached: boolean } {
  const file = sheetPdfFile(sheet, s);
  if (canShareFile(file)) {
    void navigator
      .share({ files: [file], title: sheetSubject(sheet, s) })
      .then(() => onDone("shared"))
      // A cancelled share sheet is not a failure worth a message.
      .catch(() => {});
    return { attached: true };
  }
  saveFile(file);
  onDone("saved");
  return { attached: false };
}
