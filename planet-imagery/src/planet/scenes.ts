import { rebaseToApiOrigin, requestJson, type PagedResult, type PlanetEndpoints } from './api'
import { type GeoJsonArea, type GeoJsonPolygon, type PlanetScene } from './types'

/**
 * The only item type this widget searches.
 *
 * PlanetScope is the daily-cadence product, which is what the date list is
 * built around. Widening this would mean reconciling different resolutions,
 * asset names and tile paths in one list, so it is deliberately fixed.
 */
export const SCENE_ITEM_TYPE = 'PSScene'

/** Planet's own maximum; anything larger is ignored by the API. */
const PAGE_SIZE = 250

/** Bounds one window's walk. A month over a small box never approaches this. */
const MAX_PAGES = 20

/** How many scenes one window may contribute before the walk gives up. */
const MAX_SCENES_PER_WINDOW = 500

export interface SceneSearchParams {
  /** Search area, in WGS84 degrees. */
  geometry: GeoJsonArea
  /** Inclusive lower bound on `acquired`, ISO 8601. */
  acquiredGte: string
  /** Exclusive upper bound on `acquired`, ISO 8601. */
  acquiredLt: string
  /** Cloud ceiling as a percentage, 0-100. Converted to the API's ratio here. */
  maxCloudPercent: number
}

/**
 * Build the `quick-search` request body.
 *
 * Separated from the request so the filter set is readable on its own: it is
 * the part most likely to need changing, and the part with the units trap.
 */
export function buildSearchRequest (params: SceneSearchParams): unknown {
  return {
    item_types: [SCENE_ITEM_TYPE],
    filter: {
      type: 'AndFilter',
      config: [
        {
          type: 'GeometryFilter',
          field_name: 'geometry',
          config: params.geometry
        },
        {
          type: 'DateRangeFilter',
          field_name: 'acquired',
          config: { gte: params.acquiredGte, lt: params.acquiredLt }
        },
        {
          type: 'RangeFilter',
          field_name: 'cloud_cover',
          // cloud_cover is a 0-1 ratio, not a percentage. Sending 20 here
          // would silently match everything.
          config: { lte: clampPercent(params.maxCloudPercent) / 100 }
        },
        {
          // Scenes the account cannot download also cannot be streamed: their
          // tiles come back 404. Filtering here keeps every row in the list
          // one the user can actually put on the map.
          type: 'PermissionFilter',
          config: ['assets:download']
        }
      ]
    }
  }
}

/**
 * Run one search window.
 *
 * The first page is a POST; Planet's `_links._next` for the result set is a
 * plain GET, so the walk switches method after the first page.
 */
export async function searchScenes (
  endpoints: PlanetEndpoints,
  params: SceneSearchParams,
  signal?: AbortSignal
): Promise<PagedResult<PlanetScene>> {
  const url = new URL(`${endpoints.apiOrigin}/data/v1/quick-search`)
  url.searchParams.set('_page_size', String(PAGE_SIZE))

  const scenes: PlanetScene[] = []
  let page = await requestJson(url.toString(), endpoints, {
    body: buildSearchRequest(params),
    signal
  })

  for (let pages = 0; pages < MAX_PAGES; pages++) {
    scenes.push(...((page?.features ?? []) as PlanetScene[]))
    if (scenes.length >= MAX_SCENES_PER_WINDOW) {
      return { items: scenes.slice(0, MAX_SCENES_PER_WINDOW), truncated: true }
    }
    const next = page?._links?._next
    if (!next) return { items: scenes, truncated: false }
    page = await requestJson(rebaseToApiOrigin(next, endpoints.apiOrigin), endpoints, { signal })
  }

  return { items: scenes, truncated: true }
}

/**
 * Build the XYZ template for a group of scenes.
 *
 * Planet's tile service accepts a comma-separated list of item ids and
 * composites them server-side, so a whole day is one layer and one request per
 * tile rather than one layer per strip.
 *
 * As with mosaics, ArcGIS uses `{level}/{col}/{row}` and the tokens must stay
 * unescaped, so the path is assembled by hand.
 */
export function buildSceneTileUrlTemplate (sceneIds: string[], endpoints: PlanetEndpoints): string {
  const ids = sceneIds.map((id) => encodeURIComponent(id)).join(',')
  const suffix = endpoints.apiKey ? `?api_key=${encodeURIComponent(endpoints.apiKey)}` : ''
  return `${endpoints.tilesOrigin}/data/v1/${SCENE_ITEM_TYPE}/${ids}/{level}/{col}/{row}.png${suffix}`
}

export interface SceneDateGroup {
  /** `YYYY-MM-DD` in UTC, which is how Planet dates an acquisition. */
  date: string
  /** Scenes acquired that day, newest first. */
  scenes: PlanetScene[]
}

/**
 * Collapse a flat result set into one entry per acquisition day, newest first.
 *
 * Grouping is on the UTC date rather than the viewer's local date so two people
 * looking at the same search in different timezones see the same days, and so
 * the label matches what Planet's own tools show.
 */
export function groupByDate (scenes: PlanetScene[]): SceneDateGroup[] {
  const groups = new Map<string, PlanetScene[]>()

  for (const scene of scenes) {
    const date = acquiredDate(scene)
    if (!date) continue
    const existing = groups.get(date)
    if (existing) existing.push(scene)
    else groups.set(date, [scene])
  }

  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      scenes: list.sort((a, b) => acquiredTime(b) - acquiredTime(a))
    }))
}

/** `YYYY-MM-DD` in UTC, or null when the timestamp is missing or unparseable. */
export function acquiredDate (scene: PlanetScene): string | null {
  const parsed = Date.parse(scene?.properties?.acquired ?? '')
  return isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10)
}

function acquiredTime (scene: PlanetScene): number {
  return Date.parse(scene?.properties?.acquired ?? '') || 0
}

/** Cloud cover as a whole percentage, from the API's 0-1 ratio. */
export function cloudPercent (scene: PlanetScene): number | null {
  const ratio = scene?.properties?.cloud_cover
  return typeof ratio === 'number' ? Math.round(ratio * 100) : null
}

/** `HH:MM UTC`, the only part of the timestamp the date grouping does not show. */
export function acquiredTimeLabel (scene: PlanetScene): string {
  const parsed = Date.parse(scene?.properties?.acquired ?? '')
  return isNaN(parsed) ? '' : `${new Date(parsed).toISOString().slice(11, 16)} UTC`
}

/** Bounding box of a polygon as [xmin, ymin, xmax, ymax] in degrees. */
export function polygonBbox (polygon?: GeoJsonPolygon): [number, number, number, number] | null {
  const ring = polygon?.coordinates?.[0]
  if (!ring || ring.length === 0) return null

  let xmin = Infinity
  let ymin = Infinity
  let xmax = -Infinity
  let ymax = -Infinity

  for (const point of ring) {
    const [x, y] = point ?? []
    if (typeof x !== 'number' || typeof y !== 'number') continue
    xmin = Math.min(xmin, x)
    xmax = Math.max(xmax, x)
    ymin = Math.min(ymin, y)
    ymax = Math.max(ymax, y)
  }

  return isFinite(xmin) && isFinite(ymin) ? [xmin, ymin, xmax, ymax] : null
}

/** Smallest box containing every box given, or null when there are none. */
export function unionBbox (
  boxes: Array<[number, number, number, number]>
): [number, number, number, number] | null {
  if (boxes.length === 0) return null
  return boxes.reduce((acc, box) => [
    Math.min(acc[0], box[0]),
    Math.min(acc[1], box[1]),
    Math.max(acc[2], box[2]),
    Math.max(acc[3], box[3])
  ])
}

function clampPercent (value: number): number {
  if (typeof value !== 'number' || isNaN(value)) return 100
  return Math.min(Math.max(value, 0), 100)
}
