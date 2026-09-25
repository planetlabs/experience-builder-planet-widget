/**
 * Order entry in the tasking dashboard. Deep links must start here and append
 * query parameters; no credentials are involved, the dashboard authenticates
 * the user itself.
 */
const TASKING_ORDER_URL = 'https://www.planet.com/tasking/orders/new/'

/** Roughly 10 cm at the equator, far finer than any tasking footprint. */
const COORDINATE_PRECISION = 6

export interface TaskingPoint {
  longitude: number
  latitude: number
}

export function toWkt (point: TaskingPoint): string {
  const lon = point.longitude.toFixed(COORDINATE_PRECISION)
  const lat = point.latitude.toFixed(COORDINATE_PRECISION)
  return `POINT(${lon} ${lat})`
}

/**
 * Build the tasking dashboard deep link for a clicked point.
 *
 * Deliberately carries the location and nothing else. The dashboard already
 * knows the user's contracts, products, and defaults, and pre-filling those
 * from here would mean duplicating its rules and getting an order wrong in a
 * way that costs quota.
 *
 * The parameter is encoded with `encodeURIComponent` rather than through
 * `URLSearchParams`, which turns spaces into `+`. This leaves the parentheses
 * alone and uses `%20`, matching Planet's documented examples.
 */
export function buildTaskingDeepLink (point: TaskingPoint): string {
  return `${TASKING_ORDER_URL}?geometry=${encodeURIComponent(toWkt(point))}`
}
