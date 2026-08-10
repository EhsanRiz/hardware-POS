import { useState } from "react";
import { SHOP_NAME } from "../lib/config";

// The shop wordmark (public/logo.png). Falls back to the shop name in
// brand styling if the image is missing, so the header never looks broken.
export default function ShopLogo({ className = "" }: { className?: string }) {
  const [imgOk, setImgOk] = useState(true);

  if (imgOk) {
    return (
      <img
        src="/logo.png"
        alt={SHOP_NAME}
        onError={() => setImgOk(false)}
        className={`object-contain ${className}`}
      />
    );
  }

  return (
    <span className={`font-extrabold text-brand-dark tracking-tight ${className}`}>
      {SHOP_NAME}
    </span>
  );
}
