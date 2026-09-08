/**
 * The bench: a hairline engraving of counter hardware for the sign-in screen.
 *
 * The screen used to be a green band, a cream void and three names, and the
 * void was the problem. This fills the left of a wide screen with something
 * that says "hardware shop" in the identity's own voice — single ink strokes on
 * the green, no fills, the way a catalogue plate or a blueprint draws a tool.
 *
 * They are drawn as the real things, not as icons: a box level with its
 * I-beam flanges, two vials and a grip slot; a carpenter's pencil shaved to
 * its wide lead; a hex nut in three-quarter view beside a threaded bolt; a
 * tape with its belt clip, thumb lock and riveted hook; a claw hammer whose
 * claw curves back toward a handle that swells at the grip; a screwdriver
 * with a fluted handle. The first version was six outlines and looked like a
 * clip-art sheet. What makes a line drawing read as the object is the second
 * contour — the flange, the neck, the collar — so each tool carries those.
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
    {/* SPIRIT LEVEL: box level, side view, I-beam profile, two vials, a grip slot */}
    <g style={{ "--d": "0s" } as CSSProperties}>
      <rect x="56" y="50" width="400" height="48" rx="4" pathLength={1} />
      {/* rubber end caps, thick */}
      <line x1="72" y1="50" x2="72" y2="98" pathLength={1} />
      <line x1="66" y1="50" x2="66" y2="98" pathLength={1} />
      <line x1="440" y1="50" x2="440" y2="98" pathLength={1} />
      <line x1="446" y1="50" x2="446" y2="98" pathLength={1} />
      {/* flanges of the I-beam: the web between is recessed */}
      <line x1="72" y1="59" x2="440" y2="59" pathLength={1} />
      <line x1="72" y1="89" x2="440" y2="89" pathLength={1} />
      {/* centre vial window */}
      <rect x="224" y="55" width="64" height="38" rx="5" pathLength={1} />
      <rect x="232" y="64" width="48" height="20" rx="10" pathLength={1} />
      <line x1="250" y1="64" x2="250" y2="84" pathLength={1} />
      <line x1="262" y1="64" x2="262" y2="84" pathLength={1} />
      <ellipse className="login-bubble" cx="256" cy="74" rx="7" ry="5" pathLength={1} />
      {/* plumb vial window near the left */}
      <rect x="104" y="55" width="34" height="38" rx="5" pathLength={1} />
      <rect x="114" y="60" width="14" height="28" rx="7" pathLength={1} />
      <line x1="114" y1="70" x2="128" y2="70" pathLength={1} />
      <line x1="114" y1="78" x2="128" y2="78" pathLength={1} />
      <ellipse cx="121" cy="66" rx="5" ry="4" pathLength={1} />
      {/* hand grip slot */}
      <rect x="352" y="65" width="64" height="18" rx="9" pathLength={1} />
    </g>

    {/* CARPENTER'S PENCIL: flat oval body, shaved to a wide lead */}
    <g transform="rotate(-4 220 138)" style={{ "--d": "0.3s" } as CSSProperties}>
      <path d="M 104 126 H 300 L 334 132 L 350 136 L 334 140 L 300 146 H 104 a 5 5 0 0 1 -5 -5 v -10 a 5 5 0 0 1 5 -5 z" pathLength={1} />
      {/* the shaved shoulder, and where wood becomes lead */}
      <path d="M 300 126 C 306 132 306 140 300 146" pathLength={1} />
      <path d="M 334 132 C 336 134 336 138 334 140" pathLength={1} />
      {/* the flat face's edge, and a brand band */}
      <line x1="104" y1="136" x2="300" y2="136" pathLength={1} />
      <line x1="118" y1="126" x2="118" y2="146" pathLength={1} />
      <line x1="124" y1="126" x2="124" y2="146" pathLength={1} />
    </g>

    {/* HEX NUT (three-quarter view) and a BOLT lying beside it */}
    <g style={{ "--d": "0.55s" } as CSSProperties}>
      {/* top face */}
      <path d="M 332 214 L 316 198 L 284 198 L 268 214 L 284 230 L 316 230 Z" pathLength={1} />
      {/* depth */}
      <line x1="268" y1="214" x2="268" y2="230" pathLength={1} />
      <line x1="284" y1="230" x2="284" y2="246" pathLength={1} />
      <line x1="316" y1="230" x2="316" y2="246" pathLength={1} />
      <line x1="332" y1="214" x2="332" y2="230" pathLength={1} />
      <path d="M 268 230 L 284 246 L 316 246 L 332 230" pathLength={1} />
      {/* threaded hole, with its chamfer */}
      <ellipse cx="300" cy="214" rx="15" ry="9" pathLength={1} />
      <path d="M 288 214 a 12 7 0 0 1 24 0" pathLength={1} />
    </g>
    <g style={{ "--d": "0.7s" } as CSSProperties}>
      {/* head: a hexagon seen from the side is three faces */}
      <rect x="356" y="198" width="22" height="32" rx="2" pathLength={1} />
      <line x1="356" y1="208" x2="378" y2="208" pathLength={1} />
      <line x1="356" y1="220" x2="378" y2="220" pathLength={1} />
      {/* shank, threaded */}
      <path d="M 378 206 H 470 L 474 210 V 218 L 470 222 H 378" pathLength={1} />
      <path d="M 392 206 l -3 16 M 402 206 l -3 16 M 412 206 l -3 16 M 422 206 l -3 16 M 432 206 l -3 16 M 442 206 l -3 16 M 452 206 l -3 16 M 462 206 l -3 16" pathLength={1} />
    </g>

    {/* TAPE MEASURE: a squarish case, belt clip, thumb lock, blade run out with its hook */}
    <g style={{ "--d": "0.9s" } as CSSProperties}>
      <rect x="72" y="280" width="122" height="122" rx="30" pathLength={1} />
      <rect x="86" y="294" width="94" height="94" rx="24" pathLength={1} />
      {/* the rewind hub */}
      <circle cx="133" cy="341" r="11" pathLength={1} />
      <circle cx="133" cy="341" r="4" pathLength={1} />
      {/* belt clip on the back */}
      <path d="M 72 306 h -8 a 4 4 0 0 0 -4 4 v 58 a 4 4 0 0 0 4 4 h 8" pathLength={1} />
      {/* thumb lock on the top front */}
      <rect x="150" y="272" width="26" height="12" rx="3" pathLength={1} />
      <line x1="156" y1="284" x2="156" y2="294" pathLength={1} />
      <line x1="170" y1="284" x2="170" y2="294" pathLength={1} />
      {/* the mouth, and the blade running out */}
      <path d="M 194 352 h 8 v 24 h -8" pathLength={1} />
      <line x1="202" y1="356" x2="386" y2="356" pathLength={1} />
      <line x1="202" y1="372" x2="386" y2="372" pathLength={1} />
      <path d="M 214 356 v 5 M 224 356 v 9 M 234 356 v 5 M 244 356 v 9 M 254 356 v 5 M 264 356 v 12 M 274 356 v 5 M 284 356 v 9 M 294 356 v 5 M 304 356 v 9 M 314 356 v 5 M 324 356 v 12 M 334 356 v 5 M 344 356 v 9 M 354 356 v 5 M 364 356 v 9 M 374 356 v 5" pathLength={1} />
      {/* the hook, riveted */}
      <path d="M 386 350 v 28 h 12 v -7 h -6 v -14 h 6 v -7 z" pathLength={1} />
      <circle cx="380" cy="364" r="1.6" pathLength={1} />
      <circle cx="374" cy="364" r="1.6" pathLength={1} />
    </g>

    {/* CLAW HAMMER: side view. Face on the right, the claw a curved tapered
         prong that drops below the head and turns back toward the handle, a
         handle that thins from the eye and swells again at the grip. */}
    <g transform="rotate(30 505 270)" style={{ "--d": "1.2s" } as CSSProperties}>
      {/* head */}
      <path d="M 562 128 C 567 140 567 158 562 170 L 500 170 C 486 172 470 184 458 200 L 452 206 C 452 186 462 160 480 146 C 488 138 500 132 526 130 Z" pathLength={1} />
      {/* the split in the claw, the neck, the bevel of the face */}
      <path d="M 454 202 C 460 184 470 166 486 154" pathLength={1} />
      <path d="M 528 131 C 522 145 522 158 526 170" pathLength={1} />
      <line x1="557" y1="132" x2="557" y2="166" pathLength={1} />
      {/* handle */}
      <path d="M 504 170 C 498 228 490 288 486 344 C 484 362 483 376 486 388 Q 498 402 514 390 C 517 378 516 364 516 348 C 516 290 519 228 522 170" pathLength={1} />
      {/* grip */}
      <path d="M 490 322 C 499 326 507 326 516 322" pathLength={1} />
      <path d="M 488 340 C 497 344 507 344 516 340" pathLength={1} />
      <circle cx="501" cy="382" r="2.4" pathLength={1} />
    </g>

    {/* FLAT SCREWDRIVER: a fat fluted handle, collar, shank, blade */}
    <g transform="rotate(-22 565 420)" style={{ "--d": "1.5s" } as CSSProperties}>
      <path d="M 486 405 h 66 a 15 15 0 0 1 0 30 h -66 a 15 15 0 0 1 0 -30 z" pathLength={1} />
      <line x1="494" y1="412" x2="550" y2="412" pathLength={1} />
      <line x1="494" y1="428" x2="550" y2="428" pathLength={1} />
      <rect x="566" y="411" width="9" height="18" rx="2" pathLength={1} />
      <path d="M 575 417 h 50 l 10 -3 v 12 l -10 -3 h -50" pathLength={1} />
    </g>
    </svg>
  );
}
