/**
 * Markdown out, words in.
 *
 * The model is told to answer in plain text, and mostly does; when it slips
 * — **Manage**, a `code` span, a # heading, a * bullet — the sheet must not
 * show the asterisks. The till renders text, not markdown, on purpose: an
 * answer at the counter is a sentence, not a document.
 */
export function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*\-•]\s+/gm, "· ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
