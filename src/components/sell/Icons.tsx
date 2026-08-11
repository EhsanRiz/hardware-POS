/**
 * The handful of glyphs the Sell screen needs, drawn in the Lucide idiom the
 * design system specifies (24-unit box, 2-unit stroke, round caps and joins).
 *
 * Inlined rather than pulled from the lucide-react package: the till ships nine
 * icons, and a dependency that bundles a thousand — or worse, fetches them —
 * buys nothing on a device that must boot with no network.
 */
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: "false" as const,
};

export function ScanIcon({ size = 26 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M8 8v8M12 8v8M16 8v8" strokeWidth={1.6} />
    </svg>
  );
}

export function UserIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function CashIcon({ size = 22 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}

export function CardIcon({ size = 22 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </svg>
  );
}

export function AccountIcon({ size = 22 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M3 21h18M5 21V8l7-5 7 5v13" />
      <path d="M9 21v-6h6v6" />
    </svg>
  );
}

export function PrinterIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </svg>
  );
}

export function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} strokeWidth={2.6}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function CloudOffIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} strokeWidth={2.2}>
      <path d="M3 3l18 18" />
      <path d="M6.5 18A4.5 4.5 0 0 1 6 9a6 6 0 0 1 1.2-2.3M11 6.1A6 6 0 0 1 18 12a4 4 0 0 1 1.6 7.6" />
    </svg>
  );
}

export function SyncIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} strokeWidth={2.4}>
      <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.7-4.4M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.7 4.4" />
      <path d="M20 3v5h-5M4 21v-5h5" />
    </svg>
  );
}

export function BackspaceIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M21 5H8.5L2 12l6.5 7H21a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z" />
      <path d="M17 9l-5 6M12 9l5 6" />
    </svg>
  );
}
