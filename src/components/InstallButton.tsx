import { useEffect, useState } from "react";

// Captured browser install prompt (Chrome/Edge/Android). Not in the standard
// lib DOM types, so we type the bits we use.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

// "Install app" affordance for the PWA. Shows a real install button when the
// browser offers one (Android/Chrome), or a short "Add to Home Screen" hint on
// iOS. Renders nothing once the app is already installed/standalone.
export default function InstallButton({ className = "" }: { className?: string }) {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [installed, setInstalled] = useState(isStandalone());
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    if (installed) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [installed]);

  if (installed) return null;

  const handleClick = async () => {
    if (promptEvent) {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === "accepted") setInstalled(true);
      setPromptEvent(null);
    } else if (isIos()) {
      setShowIosHint((v) => !v);
    }
  };

  // Only render when we can actually do something (Android prompt or iOS hint).
  if (!promptEvent && !isIos()) return null;

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <button
        onClick={handleClick}
        className="h-10 px-5 rounded-lg bg-gold-400 text-colophon font-semibold text-sm active:bg-gold transition-transform active:scale-95"
      >
        📲 Install app
      </button>
      {showIosHint && (
        <p className="mt-2 max-w-xs text-center text-xs text-stone-500">
          Tap the <b>Share</b> icon in Safari, then choose{" "}
          <b>Add to Home Screen</b>.
        </p>
      )}
    </div>
  );
}
