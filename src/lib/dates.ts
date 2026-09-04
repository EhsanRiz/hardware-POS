// One way to write a date, everywhere: "4 Sep 2026".
//
// The day first and the month spelt, because "9/4/2026" is the 9th of April
// to half the people who read it and the 4th of September to the other half.
// Written by hand rather than through the browser's locale tables, which
// disagree with each other about whether September is "Sep" or "Sept" and
// whether the 4th is "4" or "04" — and a slip has to print the same on every
// device in the shop.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function asDate(d: Date | string): Date | null {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
}

/** "4 Sep 2026" */
export function fmtDate(d: Date | string): string {
  const x = asDate(d);
  return x ? `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}` : "";
}

/** "4 Sep" — for a list where the year is the same on every row. */
export function fmtDayMonth(d: Date | string): string {
  const x = asDate(d);
  return x ? `${x.getDate()} ${MONTHS[x.getMonth()]}` : "";
}

/** "14:05" — 24-hour, the way a till roll reads. */
export function fmtTime(d: Date | string): string {
  const x = asDate(d);
  if (!x) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(x.getHours())}:${p(x.getMinutes())}`;
}

/** "4 Sep 2026 14:05" */
export function fmtDateTime(d: Date | string): string {
  const x = asDate(d);
  return x ? `${fmtDate(x)} ${fmtTime(x)}` : "";
}

/** "4 Sep 14:05" */
export function fmtDayMonthTime(d: Date | string): string {
  const x = asDate(d);
  return x ? `${fmtDayMonth(x)} ${fmtTime(x)}` : "";
}

/** "Thu 4 Sep 14:05" — for a warning about a day that is not today. */
export function fmtWeekdayTime(d: Date | string): string {
  const x = asDate(d);
  if (!x) return "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[x.getDay()]} ${fmtDayMonthTime(x)}`;
}
