/**
 * When a phone is worth buzzing, and what it should say.
 *
 * Kept apart from the sending so the rules can be held to directly
 * (test/push-rules.test.mjs). They are the whole difference between a
 * notification somebody acts on and one they turn off:
 *
 *   - Two things only. A sale parked for a manager means somebody is standing
 *     at a counter now; a load that should have gone means somebody is waiting
 *     at a house today. Everything else the bell shows can wait until the app
 *     is next opened.
 *   - Only when it grows. Two waiting, then one waiting, is progress and not
 *     news; a phone that buzzes on the way down teaches its owner to ignore
 *     it on the way up.
 *   - Not at night. The count of late loads climbs by itself at midnight, as
 *     today's become yesterday's, and a phone that goes off at five past
 *     twelve is a phone with notifications switched off by morning.
 */

export interface Waiting {
  approvals: number;
  deliveries_late: number;
}

/** What was last sent, as a string small enough to keep on the row. */
export function signature(w: Waiting): string {
  return `a${w.approvals}d${w.deliveries_late}`;
}

function parse(s: string | null): Waiting {
  const m = /^a(\d+)d(\d+)$/.exec(s ?? "");
  return m
    ? { approvals: Number(m[1]), deliveries_late: Number(m[2]) }
    : { approvals: 0, deliveries_late: 0 };
}

/**
 * The shop's own hours, in which a phone may be disturbed.
 *
 * The shop keeps SAST (UTC+2) and the sender only has UTC, so the offset is
 * stated here rather than guessed per device. Seven to seven: a shop that
 * opens at half past seven is not helped by being told at six, and a manager
 * at supper is not helped at all.
 */
const OPEN_FROM = 7;
const OPEN_UNTIL = 19;
const SHOP_OFFSET_HOURS = 2;

export function withinHours(now: Date): boolean {
  const hour = (now.getUTCHours() + SHOP_OFFSET_HOURS) % 24;
  return hour >= OPEN_FROM && hour < OPEN_UNTIL;
}

/**
 * Should this phone hear about it, and what does it say?
 *
 * Null for silence, which is most of the time.
 */
export function whatToSay(
  w: Waiting, lastSent: string | null, now: Date
): { title: string; body: string; tag: string; signature: string } | null {
  if (!withinHours(now)) return null;

  const was = parse(lastSent);
  const grew =
    w.approvals > was.approvals || w.deliveries_late > was.deliveries_late;
  if (!grew) return null;

  const lines: string[] = [];
  if (w.approvals > 0) {
    lines.push(w.approvals === 1
      ? "1 sale is waiting for a manager"
      : `${w.approvals} sales are waiting for a manager`);
  }
  if (w.deliveries_late > 0) {
    lines.push(w.deliveries_late === 1
      ? "1 delivery should already have gone"
      : `${w.deliveries_late} deliveries should already have gone`);
  }
  if (lines.length === 0) return null;

  return {
    // The title IS the news. The phone already says which app this is — twice
    // on iOS, which adds a "from InnovaPOS" line of its own — so a title that
    // says it a third time spends the one line somebody reads at a glance on
    // nothing. The most urgent line goes there and the rest follows under it.
    //
    // The shop's name is in neither on purpose: this arrives on a lock screen,
    // and what is on it should be the work and not the takings.
    title: lines[0],
    body: lines.slice(1).join(" · "),
    // One notification, replaced rather than stacked: three buzzes saying
    // almost the same thing is the thing people mute.
    tag: "innovapos-needs-you",
    signature: signature(w),
  };
}
