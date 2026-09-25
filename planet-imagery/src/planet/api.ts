import { DEFAULT_RENDERER } from './renderers'
import { PlanetApiError, type PlanetMosaic, type PlanetSeries } from './types'
import { type PlanetAuthMode } from '../config'

const PLANET_API_ORIGIN = 'https://api.planet.com'
/** Templated host that lets the browser fan tile requests across subdomains. */
const PLANET_TILES_TEMPLATE = 'https://tiles{subDomain}.planet.com'
const TILE_SUBDOMAINS = ['0', '1', '2', '3']

/** Stops a runaway loop if a proxy ever returns a self-referential `_next`. */
const MAX_PAGES = 50

export interface PlanetEndpoints {
  apiOrigin: string
  /** Origin for tile requests, possibly containing a `{subDomain}` token. */
  tilesOrigin: string
  subDomains: string[]
  apiKey: string
}

export interface EndpointConfigLike {
  authMode?: PlanetAuthMode
  apiKey?: string
  proxyBaseUrl?: string
}

/**
 * Which auth arrangement a configuration describes.
 *
 * Configurations saved before `authMode` existed have to keep behaving exactly
 * as they did, so an absent value is inferred from what is filled in. A proxy
 * on its own was the proxy arrangement; anything else - including a proxy
 * alongside a key, which is how a plain origin-forwarding proxy was set up -
 * was the embedded one.
 */
export function resolveAuthMode (config: EndpointConfigLike): PlanetAuthMode {
  if (config?.authMode) return config.authMode
  const hasProxy = Boolean((config?.proxyBaseUrl ?? '').trim())
  const hasKey = Boolean((config?.apiKey ?? '').trim())
  return hasProxy && !hasKey ? 'proxy' : 'embedded'
}

/**
 * Resolve the hosts to call and the credential to send.
 *
 * A configured proxy replaces both Planet origins; we drop the subdomain
 * template in that case because a proxy is a single host.
 *
 * `userKey` is the key the app user pasted into the running app, read from
 * browser storage by the caller. It is used only in `user` mode, and in that
 * mode it is the only credential considered - `config.apiKey` is ignored,
 * because a config that carries a key is not what `user` mode is for.
 */
export function resolveEndpoints (config: EndpointConfigLike, userKey: string = ''): PlanetEndpoints {
  const mode = resolveAuthMode(config)

  // Only honoured outside `user` mode. A user-supplied key goes straight to
  // Planet: a proxy exists to hold a credential the browser must not have, and
  // in this mode the browser legitimately has one of its own.
  const proxy = mode === 'user' ? '' : (config?.proxyBaseUrl ?? '').trim().replace(/\/+$/, '')

  // In `proxy` mode the server attaches the credential, so the browser sends
  // none. Any key left in the config from a previous arrangement is dropped
  // rather than forwarded, so switching modes cannot leak it.
  const apiKey = mode === 'user'
    ? userKey.trim()
    : mode === 'embedded' ? (config?.apiKey ?? '').trim() : ''

  return {
    apiOrigin: proxy || PLANET_API_ORIGIN,
    tilesOrigin: proxy || PLANET_TILES_TEMPLATE,
    subDomains: proxy ? [] : TILE_SUBDOMAINS,
    apiKey
  }
}

/** True when a credential or a proxy is in place, so calls can succeed. */
export function isConfigured (endpoints: PlanetEndpoints): boolean {
  return Boolean(endpoints.apiKey) || endpoints.apiOrigin !== PLANET_API_ORIGIN
}

/**
 * Single entry point for every Planet call, so authentication, transport
 * failures and Planet's error bodies are handled the same way everywhere.
 *
 * Exported because the scenes client in `./scenes` needs the same treatment
 * for its POST search; nothing outside this folder should call it.
 */
export async function requestJson (
  url: string,
  endpoints: PlanetEndpoints,
  options: { body?: unknown, signal?: AbortSignal } = {}
): Promise<any> {
  const headers: { [key: string]: string } = { Accept: 'application/json' }

  // Sent as a header rather than a query param so the key stays out of URLs
  // and browser logs. Tile URLs have no such option and use api_key instead.
  if (endpoints.apiKey) {
    headers.Authorization = `api-key ${endpoints.apiKey}`
  }

  const hasBody = options.body !== undefined
  if (hasBody) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(url, {
      method: hasBody ? 'POST' : 'GET',
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new PlanetApiError(0, `Could not reach ${new URL(url).host}. Check the proxy URL and your network.`)
  }

  if (!response.ok) {
    throw new PlanetApiError(response.status, `${describeStatus(response.status)}${await readApiMessage(response)}`)
  }
  return await response.json()
}

async function getJson (url: string, endpoints: PlanetEndpoints, signal?: AbortSignal): Promise<any> {
  return await requestJson(url, endpoints, { signal })
}

/**
 * Planet puts a useful reason in the body (`{"message": "path ... was not
 * found"}`). Surfacing it turns an opaque status code into something the user
 * can act on.
 */
async function readApiMessage (response: Response): Promise<string> {
  try {
    const body = await response.json()
    const message = body?.message ?? body?.general?.[0]?.message
    return message ? ` ${String(message)}` : ''
  } catch {
    return ''
  }
}

function describeStatus (status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'Planet rejected the API key (401/403). Check the key and that your plan covers this imagery.'
    case 404:
      return 'Not found (404). The mosaic or series may be outside your area of access.'
    case 429:
      return 'Rate limited by Planet (429). Try again shortly.'
    default:
      return `Planet returned HTTP ${status}.`
  }
}

/**
 * Rewrite a `_next` link onto the configured origin.
 *
 * Planet always returns absolute URLs pointing at api.planet.com, which would
 * bypass a configured proxy (and leak the fact a proxy exists) if followed
 * verbatim.
 *
 * Exported for `./scenes`, which paginates the Data API the same way.
 */
export function rebaseToApiOrigin (rawUrl: string, apiOrigin: string): string {
  try {
    const next = new URL(rawUrl)
    const base = new URL(apiOrigin)
    next.protocol = base.protocol
    next.host = base.host
    const prefix = base.pathname.replace(/\/+$/, '')
    if (prefix && !next.pathname.startsWith(prefix + '/')) {
      next.pathname = prefix + next.pathname
    }
    return next.toString()
  } catch {
    return rawUrl
  }
}

export interface PagedResult<T> {
  items: T[]
  /** True when MAX_PAGES or `limit` cut the walk short. */
  truncated: boolean
}

/**
 * Walk a paginated listing.
 *
 * Planet paginates every listing and omitting this is the classic way to
 * conclude that recent mosaics "don't exist" when they are simply on page 3.
 */
async function collectPaged<T> (
  startUrl: string,
  key: string,
  endpoints: PlanetEndpoints,
  limit: number,
  signal?: AbortSignal
): Promise<PagedResult<T>> {
  const items: T[] = []
  let url: string | null = startUrl
  let pages = 0

  while (url) {
    const page = await getJson(url, endpoints, signal)
    items.push(...((page?.[key] ?? []) as T[]))
    pages++

    if (items.length >= limit) {
      return { items: items.slice(0, limit), truncated: true }
    }
    if (pages >= MAX_PAGES) {
      return { items, truncated: true }
    }

    const next = page?._links?._next
    url = next ? rebaseToApiOrigin(next, endpoints.apiOrigin) : null
  }

  return { items, truncated: false }
}

/** List the series the key can see. Usually a short list, so we fetch all. */
export async function listSeries (
  endpoints: PlanetEndpoints,
  options: { nameContains?: string, limit?: number, signal?: AbortSignal } = {}
): Promise<PagedResult<PlanetSeries>> {
  const url = new URL(`${endpoints.apiOrigin}/basemaps/v1/series`)
  url.searchParams.set('_page_size', '250')
  if (options.nameContains) {
    url.searchParams.set('name__contains', options.nameContains)
  }
  return await collectPaged<PlanetSeries>(
    url.toString(), 'series', endpoints, options.limit ?? 500, options.signal
  )
}

/**
 * List individual mosaics.
 *
 * An account can have tens of thousands of mosaics, so callers should pass a
 * search term. `limit` bounds the walk and the result reports whether it bit.
 */
export async function listMosaics (
  endpoints: PlanetEndpoints,
  options: { nameContains?: string, limit?: number, signal?: AbortSignal } = {}
): Promise<PagedResult<PlanetMosaic>> {
  const url = new URL(`${endpoints.apiOrigin}/basemaps/v1/mosaics`)
  url.searchParams.set('_page_size', '250')
  if (options.nameContains) {
    url.searchParams.set('name__contains', options.nameContains)
  }
  return await collectPaged<PlanetMosaic>(
    url.toString(), 'mosaics', endpoints, options.limit ?? 250, options.signal
  )
}

/** List every mosaic in a series, most recent first. */
export async function listSeriesMosaics (
  endpoints: PlanetEndpoints,
  seriesId: string,
  options: { limit?: number, signal?: AbortSignal } = {}
): Promise<PagedResult<PlanetMosaic>> {
  // `/series/{id}/mosaics`, not `/mosaics/{id}/mosaics`. The latter appears in
  // the narrative docs but 404s without a trailing slash.
  const url = new URL(`${endpoints.apiOrigin}/basemaps/v1/series/${encodeURIComponent(seriesId)}/mosaics`)
  url.searchParams.set('_page_size', '250')
  const result = await collectPaged<PlanetMosaic>(
    url.toString(), 'mosaics', endpoints, options.limit ?? 2000, options.signal
  )
  return { ...result, items: sortByAcquiredDesc(result.items) }
}

/** Fetch a single mosaic by id. */
export async function getMosaic (
  endpoints: PlanetEndpoints,
  mosaicId: string,
  signal?: AbortSignal
): Promise<PlanetMosaic> {
  const url = `${endpoints.apiOrigin}/basemaps/v1/mosaics/${encodeURIComponent(mosaicId)}`
  return await getJson(url, endpoints, signal)
}

/** Newest first, so index 0 is the mosaic to show by default. */
export function sortByAcquiredDesc (mosaics: PlanetMosaic[]): PlanetMosaic[] {
  return [...mosaics].sort((a, b) => {
    const at = Date.parse(a?.first_acquired ?? '') || 0
    const bt = Date.parse(b?.first_acquired ?? '') || 0
    if (at !== bt) return bt - at
    return (b?.name ?? '').localeCompare(a?.name ?? '')
  })
}

/**
 * Build the XYZ template for a WebTileLayer.
 *
 * ArcGIS uses `{level}/{col}/{row}` rather than the `{z}/{x}/{y}` in Planet's
 * documentation, and the tokens must stay unescaped, so the path is assembled
 * by hand rather than through URL/searchParams.
 */
export function buildTileUrlTemplate (
  mosaicName: string,
  renderer: string,
  endpoints: PlanetEndpoints
): string {
  const query: string[] = []
  if (renderer && renderer !== DEFAULT_RENDERER) {
    query.push(`proc=${encodeURIComponent(renderer)}`)
  }
  if (endpoints.apiKey) {
    query.push(`api_key=${encodeURIComponent(endpoints.apiKey)}`)
  }
  const suffix = query.length ? `?${query.join('&')}` : ''
  const path = `/basemaps/v1/planet-tiles/${encodeURIComponent(mosaicName)}/gmap/{level}/{col}/{row}.png`
  return `${endpoints.tilesOrigin}${path}${suffix}`
}
