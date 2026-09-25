import { requestJson, resolveEndpoints } from './api'
import { PlanetApiError } from './types'

/**
 * The app user's own Planet API key, held in the browser.
 *
 * This is what makes `user` auth mode safe to publish on static hosting: the
 * key is typed into the running app and never enters the widget config, so the
 * app JSON that gets served carries no credential at all. Each person brings
 * their own key, which means no shared secret, per-person quota attribution,
 * and revocation that affects one person rather than everyone.
 *
 * The trade is that the key sits in browser storage, readable by any script
 * running on this origin. That is the same exposure as a key in the config -
 * the difference is whose key is exposed and to how many people.
 */

/**
 * Not namespaced per widget instance, deliberately: two Planet widgets in one
 * app, or two apps on one origin, are the same person and should not each
 * demand the key. Prefixed because localStorage is shared across the origin.
 */
const STORAGE_KEY = 'planet-imagery.api-key'

/**
 * `session` clears when the tab closes; `device` persists until cleared.
 *
 * Offered to the user rather than fixed by the creator, because it is their
 * credential and their machine - a shared kiosk and a personal laptop want
 * different answers and only the person sitting there knows which this is.
 */
export type KeyPersistence = 'session' | 'device'

/**
 * Storage access throws rather than returning null in some configurations -
 * Safari private browsing, and any browser set to block site data - so every
 * access is guarded and a failure degrades to "no key", which just means the
 * user is asked again.
 */
function safely<T> (fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * Session storage wins over device storage, so a key entered for this tab
 * overrides a remembered one rather than being silently ignored.
 */
export function readStoredKey (): string {
  return safely(() => window.sessionStorage.getItem(STORAGE_KEY), null) ??
    safely(() => window.localStorage.getItem(STORAGE_KEY), null) ??
    ''
}

export function storeKey (key: string, persistence: KeyPersistence): void {
  const trimmed = key.trim()
  // Written to one store and removed from the other, so switching from
  // "remember" to "just this session" actually forgets the remembered key.
  const [target, other] = persistence === 'device'
    ? [window.localStorage, window.sessionStorage]
    : [window.sessionStorage, window.localStorage]
  safely(() => { target.setItem(STORAGE_KEY, trimmed) }, undefined)
  safely(() => { other.removeItem(STORAGE_KEY) }, undefined)
}

export function clearStoredKey (): void {
  safely(() => { window.sessionStorage.removeItem(STORAGE_KEY) }, undefined)
  safely(() => { window.localStorage.removeItem(STORAGE_KEY) }, undefined)
}

/** Whether the browser will actually keep a key past this page load. */
export function canRemember (): boolean {
  return safely(() => {
    const probe = STORAGE_KEY + '.probe'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  }, false)
}

/**
 * Check a key before storing it, so a typo fails at the point of entry rather
 * than as a wall of 401s from whatever the mode happens to load first.
 *
 * `/basemaps/v1/series` is the probe because every Planet key authenticates
 * against it whether or not the account has basemap entitlements - and that
 * distinction is exactly what the status code carries. 401 means Planet did
 * not recognise the credential, which is a bad key. 403 means it recognised
 * the key and declined this particular product, which is a fine key on an
 * account this widget may still be useful on, so it passes.
 */
export async function validateKey (key: string, signal?: AbortSignal): Promise<void> {
  const endpoints = resolveEndpoints({ authMode: 'user' }, key)
  const url = `${endpoints.apiOrigin}/basemaps/v1/series?_page_size=1`
  try {
    await requestJson(url, endpoints, { signal })
  } catch (err) {
    if (err instanceof PlanetApiError && err.status === 403) return
    throw err
  }
}
