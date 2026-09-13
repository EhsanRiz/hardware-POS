import { useEffect, useState } from "react";
import { installPrompt, onInstallChange, promptInstall, wasInstalled } from "../lib/install";

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

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

// "Install app" affordance for the PWA. A real install button when the
// browser has offered one (Android/Chrome — caught at boot, see lib/install.ts),
// or a short "how to" on a phone that has not: Safari has no offer to make,
// and an Android browser other than Chrome may not either. Renders nothing
// once the app is already installed/standalone, and nothing on a desktop
// with no offer, where there is nothing a person could do.
export default function InstallButton({ className = "" }: { className?: string }) {
  const [, bump] = useState(0);
  const [installed, setInstalled] = useState(isStandalone() || wasInstalled());
  const [showHint, setShowHint] = useState(false);

  useEffect(() => onInstallChange(() => {
    if (wasInstalled()) setInstalled(true);
    bump((n) => n + 1);
  }), []);

  if (installed) return null;

  const offer = installPrompt();
  const phone = isIos() || isAndroid();
  // Only render when we can actually do something.
  if (!offer && !phone) return null;

  const handleClick = async () => {
    if (offer) {
      if (await promptInstall()) setInstalled(true);
    } else {
      setShowHint((v) => !v);
    }
  };

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <button
        onClick={handleClick}
        className="h-10 px-5 rounded-lg bg-gold-400 text-colophon font-semibold text-sm active:bg-gold transition-transform active:scale-95"
      >
        📲 Install app
      </button>
      {showHint && (
        <p className="mt-2 max-w-xs text-center text-xs text-stone-500 install-hint">
          {isIos() ? (
            <>Tap the <b>Share</b> icon in Safari, then choose <b>Add to Home Screen</b>.</>
          ) : (
            <>Open the browser's menu (⋮), then choose <b>Install app</b> or <b>Add to Home screen</b>.</>
          )}
        </p>
      )}
    </div>
  );
}
