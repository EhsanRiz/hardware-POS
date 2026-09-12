// Tiny bridge so the (non-React) print layer can ask the UI to show an in-app
// preview popup on desktop, instead of opening a separate browser window.
/** A button on the preview besides Close and Print — "Cancel this sale". */
export interface PreviewAction {
  label: string;
  run: () => void;
}

type Handler = (
  text: string,
  title: string,
  action?: PreviewAction,
  direct?: boolean
) => void;

let handler: Handler | null = null;

export function setPrintPreviewHandler(h: Handler | null): void {
  handler = h;
}

export function openPrintPreview(text: string, title = "Receipt", action?: PreviewAction): void {
  handler?.(text, title, action);
}

/**
 * Print without showing anything.
 *
 * Same path, same renderer — the emphasis markers and the barcode have to come
 * out identically, so this cannot be a second implementation of the slip. The
 * component fills its hidden print area, asks the browser to print, and clears
 * itself; nothing is ever drawn over the till.
 */
export function printWithoutPreview(text: string, title = "Receipt"): void {
  handler?.(text, title, undefined, true);
}
