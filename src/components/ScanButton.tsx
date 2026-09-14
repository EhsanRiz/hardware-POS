import { useState } from "react";
import BarcodeScanner from "./BarcodeScanner";
import { useCamera } from "../lib/useCamera";

/**
 * The phone's answer to the counter's scanner gun.
 *
 * A gun is a keyboard: at the till it types the digits into whichever box has
 * focus and presses Enter, which is why every search box in this app takes a
 * barcode without needing a button at all. A phone has no gun and a lens
 * instead — so wherever a scanned code would be useful, this goes beside the
 * box, and the code it reads is handed over exactly as though it had been
 * typed.
 *
 * Nothing at all where there is no camera. A button that opens a viewfinder
 * that cannot open is worse than no button, and the counter machine — a
 * PinnPOS all-in-one with no lens in it — is the case that proves it.
 */
export default function ScanButton({
  onCode,
  disabled,
  className = "btn-line",
}: {
  onCode: (code: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const camera = useCamera();
  const [open, setOpen] = useState(false);
  if (!camera) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Scan a barcode with the camera"
      >
        Scan
      </button>
      {open && (
        <BarcodeScanner
          // One code, then the viewfinder closes: the person is looking
          // something up, not walking an aisle, and a label left in view must
          // not keep firing.
          onCode={(code) => {
            setOpen(false);
            onCode(code);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
