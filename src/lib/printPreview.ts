// Tiny bridge so the (non-React) print layer can ask the UI to show an in-app
// preview popup on desktop, instead of opening a separate browser window.
type Handler = (text: string, title: string) => void;

let handler: Handler | null = null;

export function setPrintPreviewHandler(h: Handler | null): void {
  handler = h;
}

export function openPrintPreview(text: string, title = "Receipt"): void {
  handler?.(text, title);
}
