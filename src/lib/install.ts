// The browser's "install this app" offer, caught early.
//
// Chrome fires beforeinstallprompt ONCE, early in the page load — often before
// React has mounted anything, let alone run the effect that listened for it.
// So the phone's Install button listened for an event that had already gone
// by, rendered nothing, and the app looked like it could not be installed.
// The listener now lives here, at module level, imported by main.tsx before
// React mounts; the button reads what was caught.

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let captured: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    captured = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    captured = null;
    notify();
  });
}

export function installPrompt(): BeforeInstallPromptEvent | null {
  return captured;
}

export function wasInstalled(): boolean {
  return installed;
}

/** Spend the captured offer. Resolves to whether the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = captured;
  if (!ev) return false;
  captured = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  if (outcome === "accepted") installed = true;
  notify();
  return outcome === "accepted";
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
