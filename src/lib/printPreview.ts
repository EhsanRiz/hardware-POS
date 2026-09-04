// Tiny bridge so the (non-React) print layer can ask the UI to show an in-app
// preview popup on desktop, instead of opening a separate browser window.
/** A button on the preview besides Close and Print — "Cancel this sale". */
export interface PreviewAction {
  label: string;
  run: () => void;
}

type Handler = (text: string, title: string, action?: PreviewAction) => void;

let handler: Handler | null = null;

export function setPrintPreviewHandler(h: Handler | null): void {
  handler = h;
}

export function openPrintPreview(text: string, title = "Receipt", action?: PreviewAction): void {
  handler?.(text, title, action);
}
