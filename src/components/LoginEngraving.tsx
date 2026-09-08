/**
 * The bench: a hairline engraving of counter hardware for the sign-in screen.
 *
 * The screen used to be a green band, a cream void and three names, and the
 * void was the problem. This fills the left of a wide screen with something
 * that says "hardware shop" in the identity's own voice — single ink strokes on
 * the green, no fills, the way a catalogue plate or a blueprint draws a tool.
 * A cartoon hammer would have said "different product".
 *
 * Motion is one gesture, once: the strokes draw themselves in over about two
 * seconds when the screen appears, and the level's bubble settles. Then it is
 * still. The till idles on this screen all day on a tablet that has to survive
 * load shedding, so there is no loop, no canvas, nothing that keeps a core
 * busy — it is stroke-dashoffset in CSS, and it honours reduced-motion, where
 * the plate simply appears.
 *
 * Every stroked shape carries pathLength="1" so the same dasharray draws each
 * one edge to edge regardless of its real length; `--d` staggers the start so
 * the tools arrive one after another rather than all at once.
 */
import type { CSSProperties } from "react";

export default function LoginEngraving({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`login-engraving ${className}`}
      viewBox="0 0 640 460"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Spirit level across the top. */}
      <g style={{ "--d": "0s" } as CSSProperties}>
        <rect x="44" y="58" width="352" height="34" rx="6" pathLength={1} />
        <line x1="60" y1="58" x2="60" y2="92" pathLength={1} />
        <line x1="380" y1="58" x2="380" y2="92" pathLength={1} />
        <rect x="198" y="64" width="44" height="22" rx="11" pathLength={1} />
        <line x1="214" y1="64" x2="214" y2="86" pathLength={1} />
        <line x1="226" y1="64" x2="226" y2="86" pathLength={1} />
        {/* The bubble: drawn last, then it settles into the marks. */}
        <circle className="login-bubble" cx="220" cy="75" r="5.5" pathLength={1} />
      </g>

      {/* Tape measure, bottom left, tape run out to the right. */}
      <g transform="translate(0 14)" style={{ "--d": "0.35s" } as CSSProperties}>
        <circle cx="122" cy="330" r="62" pathLength={1} />
        <circle cx="122" cy="330" r="46" pathLength={1} />
        <circle cx="122" cy="330" r="14" pathLength={1} />
        <path d="M 168 300 Q 200 318 184 350" pathLength={1} />
        <rect x="184" y="318" width="20" height="24" rx="2" pathLength={1} />
        <line x1="204" y1="322" x2="372" y2="322" pathLength={1} />
        <line x1="204" y1="338" x2="372" y2="338" pathLength={1} />
        <path
          d="M 216 322 v 5 M 228 322 v 8 M 240 322 v 5 M 252 322 v 8 M 264 322 v 5 M 276 322 v 11 M 288 322 v 5 M 300 322 v 8 M 312 322 v 5 M 324 322 v 8 M 336 322 v 5 M 348 322 v 11 M 360 322 v 5"
          pathLength={1}
        />
        <path d="M 372 316 v 28 h 8 v -6 h -4 v -16 h 4 v -6 z" pathLength={1} />
      </g>

      {/* Claw hammer on the right, handle down and to the left. Side view: a
          block with the striking face to the right, a tapered claw curving
          away to the left, and the handle hanging from under the block. */}
      <g
        transform="rotate(38 500 240)"
        style={{ "--d": "0.7s" } as CSSProperties}
      >
        <rect x="498" y="118" width="62" height="44" rx="5" pathLength={1} />
        <path
          d="M 498 122 C 464 118 438 136 434 168 L 446 172 C 452 152 474 144 498 146"
          pathLength={1}
        />
        <line x1="546" y1="118" x2="546" y2="162" pathLength={1} />
        <path d="M 490 162 v 204 a 11 11 0 0 0 22 0 v -204" pathLength={1} />
        <line x1="490" y1="300" x2="512" y2="300" pathLength={1} />
        <line x1="490" y1="312" x2="512" y2="312" pathLength={1} />
      </g>

      {/* Hex nut and bolt, centre. */}
      <g transform="translate(0 22)" style={{ "--d": "1.05s" } as CSSProperties}>
        <path
          d="M 300 176 l 30 17 v 34 l -30 17 l -30 -17 v -34 z"
          pathLength={1}
        />
        <circle cx="300" cy="210" r="13" pathLength={1} />
        <path d="M 300 197 a 13 13 0 0 1 9 23" pathLength={1} />
        <rect x="352" y="196" width="118" height="20" rx="3" pathLength={1} />
        <path
          d="M 376 196 v 20 M 390 196 v 20 M 404 196 v 20 M 418 196 v 20 M 432 196 v 20 M 446 196 v 20"
          pathLength={1}
        />
        <path d="M 352 200 h -18 v 12 h 18" pathLength={1} />
      </g>

      {/* Carpenter's pencil in the lane under the level, barely tilted. */}
      <g
        transform="rotate(-5 200 140)"
        style={{ "--d": "1.3s" } as CSSProperties}
      >
        <path
          d="M 96 130 h 190 l 26 10 l -26 10 h -190 a 4 4 0 0 1 -4 -4 v -12 a 4 4 0 0 1 4 -4 z"
          pathLength={1}
        />
        <line x1="286" y1="130" x2="286" y2="150" pathLength={1} />
        <line x1="112" y1="130" x2="112" y2="150" pathLength={1} />
        <line x1="96" y1="140" x2="286" y2="140" pathLength={1} />
      </g>
    </svg>
  );
}
