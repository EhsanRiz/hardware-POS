/**
 * The InnovaPOS mark: four corner brackets closing on a barcode.
 *
 * Geometry is from design_handoff_innovapos §2, on a 96-unit box: 12-unit
 * margin, 18-unit bracket arms, 28-unit interior bars. The handoff draws three
 * masters at different stroke weights and forbids scaling one to another's
 * size, because a 5.5-unit stroke that reads as a crisp frame at 64px turns
 * into hairline mush at 16px.
 *
 *   A — 64px and up   stroke 5.5   three bars   round caps
 *   B — 32-48px       stroke 8.5   two bars     round caps
 *   C — 16px          stroke 13    no bars      square caps, pixel-snapped
 *
 * Master C drops the round caps deliberately: at 16px a rounded terminal costs
 * a whole pixel of arm length and reads as a blur.
 */
export default function InnovaMark({
  size = 26,
  onGreen = false,
  className = "",
}: {
  size?: number;
  /** Green grounds take the lifted amber; cream grounds take the base amber. */
  onGreen?: boolean;
  className?: string;
}) {
  const frame = onGreen ? "#e0b45c" : "#c8912f";
  const bars = onGreen ? "#c8912f" : "#8a5f14";
  const master = size >= 64 ? "A" : size >= 24 ? "B" : "C";
  const stroke = master === "A" ? 5.5 : master === "B" ? 8.5 : 13;
  const cap = master === "C" ? "square" : "round";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      shapeRendering={master === "C" ? "crispEdges" : undefined}
    >
      <path
        d="M30 12H12v18M66 12h18v18M84 66v18H66M30 84H12V66"
        stroke={frame}
        strokeWidth={stroke}
        strokeLinecap={cap}
      />
      {master === "A" && (
        <path
          d="M34 34v28M46 34v28M62 34v28"
          stroke={bars}
          strokeWidth={stroke}
          strokeLinecap={cap}
        />
      )}
      {master === "B" && (
        <path
          d="M38 36v24M58 36v24"
          stroke={bars}
          strokeWidth={stroke}
          strokeLinecap={cap}
        />
      )}
    </svg>
  );
}

/**
 * Mark + wordmark + edition rule, the app-chrome lockup.
 *
 * The handoff's architecture rule 3: never stack three tiers. The house name
 * (InnovaEarth) does not appear beside the edition — it belongs in the footer
 * and on the invoice, not in the same lockup.
 */
export function InnovaLockup({
  edition = "Hardware",
  onGreen = false,
}: {
  edition?: string | null;
  onGreen?: boolean;
}) {
  return (
    <div className="sell-lockup">
      <InnovaMark size={26} onGreen={onGreen} />
      <span className="sell-wordmark">
        Innova<span>POS</span>
      </span>
      {edition && (
        <>
          <span className="sell-rule-v" />
          <span className="sell-edition">{edition}</span>
        </>
      )}
    </div>
  );
}
