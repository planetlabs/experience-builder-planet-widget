import { type PlanetEndpoints } from './api'

/**
 * Streaming imagery that a tasking order has already delivered.
 *
 * Deliberately built on nothing but Planet's API Tile Service, which serves any
 * catalog item as XYZ tiles given its item type and id:
 *
 *   https://tiles.planet.com/data/v1/{item_type}/{item_id}/{z}/{x}/{y}.png
 *
 * That is the same endpoint the daily scene search uses, so this mode adds no
 * new API surface and, importantly, makes no call to the Tasking API. The ids
 * come from a feature layer the app creator configures, which is what scopes
 * access: an app user can stream the captures on that layer and nothing else,
 * rather than browsing the account's whole archive.
 *
 * There is no renderer choice here, unlike mosaics. The tile service returns a
 * compressed form of the item's `visual` asset - true colour - and takes no
 * band or index parameter.
 */

/**
 * The item types this mode will stream.
 *
 * A SkySatCollect is the orthorectified composite of the ~60 scenes along one
 * imaging strip, and is what a SkySat tasking order delivers. A SkySatScene is
 * a single frame within that strip.
 *
 * Pelican has no Collect product at all: a strip is captured by a line-scan
 * sensor and delivered as a run of framed PelicanScenes. Streaming a whole
 * Pelican strip therefore means naming every frame in one URL, which is why an
 * id field here holds a list rather than a single value.
 */
export const STREAMABLE_ITEM_TYPES = ['SkySatCollect', 'SkySatScene', 'PelicanScene'] as const

export type TaskedItemType = typeof STREAMABLE_ITEM_TYPES[number]

/**
 * A SkySat item id: date, time, satellite, frame.
 *
 * The satellite segment has to start with a letter (`ssc1`, `ssc4d3`), which is
 * what separates these from the other constellations - a PlanetScope id
 * (`20240310_153114_78_24f4`) and a Pelican id (`20250614_043400_87_3009`) both
 * put a number there.
 */
const SKYSAT_ITEM_ID = /^\d{8}_\d{6}_[a-z][a-z0-9]*_(u?)(\d+)$/i

/**
 * Conservative shape for any catalog id, applied to every id before it reaches
 * a URL. Planet ids are alphanumerics with `_`, `-` and `.`; refusing anything
 * else keeps a stray `/` or `?` in a layer's data from rewriting the request.
 */
const CATALOG_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/

/**
 * The ids in one field value.
 *
 * Comma-delimited because that is what the tile service accepts for multiple
 * items, and what `planet-capture-layer` writes for a Pelican strip. A single
 * id is just a list of one, so there is no second code path for the SkySat case.
 */
export function parseItemIds (value: unknown): string[] {
  if (value === null || value === undefined) return []
  return String(value)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/**
 * The item type an id list names on its own, or null when the ids cannot say.
 *
 * Only SkySat can be inferred. Planet encodes it in the id - a frame segment
 * prefixed `u` is a Collect, a bare number is a Scene - so a SkySat-only layer
 * needs no item type column.
 *
 * Pelican cannot be inferred at all: `20250614_043400_87_3009` is shaped exactly
 * like the PlanetScope id `20240310_153114_78_24f4`, and guessing wrong streams
 * empty tiles. Those layers must configure an item type field.
 */
export function itemTypeFromIds (itemIds: string[]): TaskedItemType | null {
  if (itemIds.length === 0) return null

  let resolved: TaskedItemType | null = null
  for (const id of itemIds) {
    const match = SKYSAT_ITEM_ID.exec(id)
    if (!match) return null

    const itemType: TaskedItemType = match[1] ? 'SkySatCollect' : 'SkySatScene'
    // One URL carries one item type segment, so a mixed list cannot stream.
    if (resolved && resolved !== itemType) return null
    resolved = itemType
  }
  return resolved
}

/**
 * The item type to stream these ids as, or null when there is no safe answer.
 *
 * The configured column wins when it names a type this mode can stream, because
 * only the catalog knows a Pelican id from a PlanetScope one. Otherwise it falls
 * back to what the ids themselves imply, which keeps a SkySat-only layer working
 * with no item type column at all.
 */
export function resolveItemType (configured: unknown, itemIds: string[]): TaskedItemType | null {
  if (itemIds.length === 0) return null
  if (!itemIds.every((id) => CATALOG_ITEM_ID.test(id))) return null

  const declared = String(configured ?? '').trim().toLowerCase()
  const known = STREAMABLE_ITEM_TYPES.find((itemType) => itemType.toLowerCase() === declared)
  return known ?? itemTypeFromIds(itemIds)
}

/**
 * The XYZ template for one capture, in the placeholder spelling WebTileLayer
 * wants.
 *
 * Ids are joined with a literal comma rather than a percent-encoded one: a comma
 * is a legal path character and Planet's own documentation spells the multi-item
 * form that way. Each id is still encoded individually, so the only comma in the
 * segment is the one this function put there.
 *
 * The key is appended as a query parameter rather than sent as a header for the
 * same reason the other tile builders do it: tiles are loaded as images by the
 * ArcGIS API, and an `<img>` request carries no custom headers. In proxy mode
 * `endpoints.apiKey` is empty and the proxy attaches the credential instead.
 */
export function buildTaskedTileUrlTemplate (
  itemType: TaskedItemType,
  itemIds: string[],
  endpoints: PlanetEndpoints
): string {
  const suffix = endpoints.apiKey ? `?api_key=${encodeURIComponent(endpoints.apiKey)}` : ''
  const ids = itemIds.map((id) => encodeURIComponent(id)).join(',')
  return `${endpoints.tilesOrigin}/data/v1/${itemType}/${ids}/{level}/{col}/{row}.png${suffix}`
}

/**
 * A field value normalised to `YYYY-MM-DD` in UTC, or null if it is not a date.
 *
 * The date column is whatever the layer happens to use - an epoch number from a
 * hosted feature service, an ISO string from a shapefile import - and it is
 * only ever displayed, sorted and filtered on, never sent to Planet. UTC so
 * that two people in different timezones see the same day for a capture, which
 * is also the day Planet's own tools label it with.
 */
export function toIsoDate (value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null

  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'number' ? value : String(value))

  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}
