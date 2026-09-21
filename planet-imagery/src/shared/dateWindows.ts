/**
 * UTC date arithmetic for month-at-a-time searching.
 *
 * Two modes search a long date range by walking it backwards one month at a
 * time: the Planet Data API for daily scenes, and the catalog search for a data
 * collection. Both want the same answer to "what is the next window", so the
 * arithmetic lives here rather than in either of them.
 *
 * Everything is UTC. Acquisition timestamps are UTC, so grouping on the
 * viewer's local date would put the same image on different days for two people
 * looking at the same search.
 */

/**
 * One month of the overall date range, searched on its own.
 *
 * A single request for a year would either be truncated or take long enough to
 * feel broken, and the results would be unreadable anyway. Searching a month at
 * a time gives the user something to look at immediately and lets them decide
 * whether to keep walking backwards.
 */
export interface SearchWindow {
  /** Inclusive, ISO 8601. */
  gte: string
  /** Exclusive, ISO 8601. */
  lt: string
}

/** Midnight UTC on a `YYYY-MM-DD` date. */
export function startOfDayUtc (date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

/**
 * Shift a date by whole months, clamping the day so 31 March minus one month
 * is the end of February rather than spilling forward into March.
 */
export function addMonthsUtc (date: Date, months: number): Date {
  const day = date.getUTCDate()
  const shifted = new Date(date.getTime())
  shifted.setUTCDate(1)
  shifted.setUTCMonth(shifted.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  shifted.setUTCDate(Math.min(day, lastDay))
  return shifted
}

/**
 * The next month-long window to search, walking backwards from `until`.
 *
 * `until` is the exclusive upper bound not yet covered: the end of the range on
 * the first call, then the previous window's lower bound. Returns null once the
 * whole range has been covered, which is what retires the "Load more" button.
 *
 * Each window's upper bound is the previous window's lower bound, so uneven
 * month lengths shift the boundaries but never skip or repeat a day.
 */
export function nextSearchWindow (startDate: string, until: Date): SearchWindow | null {
  const rangeStart = startOfDayUtc(startDate)
  if (!(until > rangeStart)) return null

  const candidate = addMonthsUtc(until, -1)
  const lower = candidate > rangeStart ? candidate : rangeStart
  return { gte: lower.toISOString(), lt: until.toISOString() }
}

/**
 * The exclusive upper bound for a range ending on `endDate`.
 *
 * The end date is inclusive to the user, so the bound is the following
 * midnight; otherwise picking today would return nothing from today.
 */
export function exclusiveEnd (endDate: string): Date {
  return addDaysUtc(startOfDayUtc(endDate), 1)
}

export function addDaysUtc (date: Date, days: number): Date {
  const shifted = new Date(date.getTime())
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted
}

/** `YYYY-MM-DD`, the format the date inputs use. */
export function toDateInputValue (date: Date): string {
  return date.toISOString().slice(0, 10)
}
