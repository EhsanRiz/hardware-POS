import { useState } from "react";

// Shows the real 4D logo (public/4dcs-logo.jpg) if present, otherwise falls
// back to an on-brand text wordmark.
export default function BrandMark({
  showTagline = false,
  className = "",
}: {
  showTagline?: boolean;
  className?: string;
}) {
  const [imgOk, setImgOk] = useState(true);

  if (imgOk) {
    return (
      <img
        src="/4dcs-logo.jpg"
        alt="4D Climate Solutions"
        onError={() => setImgOk(false)}
        className={`object-contain ${className}`}
      />
    );
  }

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex items-baseline gap-1.5 leading-none">
        <span className="font-extrabold text-brand-dark text-2xl">4D</span>
        <span className="font-bold italic text-accent-dark text-2xl">
          Climate Solutions
        </span>
      </div>
      {showTagline && (
        <span className="text-taupe text-[11px] tracking-wide mt-1">
          creative · innovative · green · sustainable
        </span>
      )}
    </div>
  );
}
