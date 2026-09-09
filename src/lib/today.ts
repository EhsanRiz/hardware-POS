/**
 * "Tuesday 8 September 2026" — the day, written out, for someone opening up.
 * Used on the sign-in door and on the first-run door, which must agree.
 */
export function todayLine(now = new Date()): string {
  const part = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", opts).format(now);
  return `${part({ weekday: "long" })} ${part({ day: "numeric" })} ${part({ month: "long" })} ${part({ year: "numeric" })}`;
}
