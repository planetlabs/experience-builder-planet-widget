import { type ImmutableObject } from 'jimu-core'

export type IMConfig = ImmutableObject<Config>

/**
 * Which Planet capability this instance of the widget exposes.
 *
 * Experience Builder has no notion of widget variants: one folder is one entry
 * in the Insert panel with one settings panel. The mode is therefore carried in
 * the config, chosen by the creator before anything else, and both the settings
 * panel and the runtime branch on it. Several instances of the widget can sit
 * in the same app in different modes, because each instance has its own config.
 */
export type PlanetMode = 'mosaics' | 'scenes' | 'tasking'

/**
 * How the widget obtains credentials for api.planet.com.
 *
 * `embedded`  The creator's key, saved in the app configuration. Readable by
 *             anyone who can open the app, so it is only appropriate behind
 *             your own authentication.
 * `proxy`     No credential in the browser at all. A server the creator runs
 *             holds the key and injects it; see the `planet-proxy` service.
 * `user`      Each app user pastes their own key at runtime. It lives in that
 *             person's browser and never enters the configuration, so the
 *             published app can sit on static hosting with no secret in it and
 *             no server to run.
 */
export type PlanetAuthMode = 'embedded' | 'proxy' | 'user'

/** Whether a configured entry is a single mosaic or a time series of them. */
export type PlanetItemKind = 'series' | 'mosaic'

/**
 * One mosaic or series the app creator has chosen to expose to app users.
 *
 * For a `series` we store only the series id: the individual mosaics are
 * listed at runtime so the widget picks up new timesteps as Planet publishes
 * them, rather than freezing whatever existed at configuration time.
 */
export interface PlanetItem {
  kind: PlanetItemKind
  /** Series id, or mosaic id for a one-off mosaic. */
  id: string
  /** Display name shown in the widget. */
  name: string
  /** Mosaic name used to build tile URLs. Only set when kind is 'mosaic'. */
  mosaicName?: string
  /**
   * Whether the underlying product accepts `proc=` index rendering. Planet
   * only renders false-colour indices for Surface Reflectance mosaics.
   *
   * Meaningful for a single mosaic only. A series is resolved at runtime from
   * the mosaic actually being displayed, since the series listing carries no
   * datatype.
   */
  supportsIndices: boolean
  /**
   * Switch this item on as soon as the widget loads, showing its most recent
   * imagery.
   *
   * At most one configured item carries this, enforced in the settings panel:
   * mosaics are opaque, so several turning themselves on would just stack and
   * hide each other.
   */
  defaultOn?: boolean
}

export interface Config {
  /**
   * Unset until the creator picks one. The settings panel shows nothing but
   * the mode chooser while this is empty.
   */
  mode?: PlanetMode

  /**
   * How credentials are obtained. Absent on configurations saved before this
   * setting existed, which `resolveAuthMode` reads as the arrangement those
   * configurations already described.
   */
  authMode?: PlanetAuthMode

  /**
   * Planet API key, used by `embedded` auth mode only.
   *
   * Persisted in the app configuration and therefore readable by anyone who
   * can load the app. Only deploy with a key stored here when the app itself
   * sits behind your own authentication; otherwise use `proxy` or `user` mode.
   *
   * Shared by every mode that talks to api.planet.com. Never holds an app
   * user's own key - that lives in the browser, see `planet/userKey`.
   */
  apiKey: string
  /**
   * Optional origin substituted for both api.planet.com and tiles.planet.com.
   *
   * Both hosts serve paths under `/basemaps/v1/`, so a single proxy can route
   * on the subpath: `/basemaps/v1/mosaics` and `/basemaps/v1/series` to
   * api.planet.com, `/basemaps/v1/planet-tiles` to tiles.planet.com.
   */
  proxyBaseUrl: string

  // Per-mode settings live in their own block so switching modes back and
  // forth never discards what was configured for the other one. Modes that
  // have not been built yet add their block here when they are.
  mosaics?: MosaicsConfig
  scenes?: ScenesConfig
  tasking?: TaskingConfig
}

/**
 * Tasking settings.
 *
 * The deep link itself has nothing to configure: it carries only the clicked
 * location and the dashboard supplies every other default from the user's
 * account. Everything here belongs to the archive beta, which is off until a
 * creator turns it on and points it at a layer.
 */
export interface TaskingConfig {
  /**
   * Beta: let app users stream imagery from tasking orders already delivered.
   *
   * Off by default, and off is not just caution: turning it on means the widget
   * starts needing a Planet credential, which an instance that only deep-links
   * to the dashboard does not.
   */
  archiveEnabled?: boolean
  /**
   * Field on the configured layer holding the Planet catalog item id, eg
   * `20260906_133038_ssc1_u0001`.
   *
   * This layer is the access control. The widget streams the captures it lists
   * and has no way to reach anything else in the account's archive, so an admin
   * scopes what app users can see by choosing what goes in the layer.
   *
   * May hold several comma-delimited ids. That is how a Pelican strip streams:
   * Pelican has no Collect product, so a whole strip means naming each of its
   * framed scenes in one tile URL.
   */
  itemIdField?: string
  /**
   * Field holding the Planet item type, eg `PelicanScene`.
   *
   * Optional, and only because a SkySat id carries its own type - the `ssc1`
   * satellite segment and the `u`-prefixed frame number. Nothing distinguishes
   * a Pelican id from a PlanetScope one, so a layer holding Pelican has to say
   * which it is or its captures will not stream.
   */
  itemTypeField?: string
  /**
   * Field holding the acquisition date.
   *
   * Never sent to Planet - the tile service is keyed on the item id alone. It
   * labels each capture, orders the layers so the newest draws on top, and
   * drives the date filter in the widget.
   */
  dateField?: string
}

export interface MosaicsConfig {
  /** Mosaics and series exposed to app users, in the order they appear in the widget. */
  items: PlanetItem[]
}

/**
 * Daily scene search settings.
 *
 * Only the guard rails live here. Everything else about a search — the area,
 * the dates, the cloud ceiling — is chosen by the app user at runtime, because
 * a scene search is a question about one place at one moment rather than a
 * fixed set of layers.
 */
export interface ScenesConfig {
  /**
   * Largest search area an app user may draw, in square kilometres.
   *
   * A scene search is unbounded in the number of results it can return, and a
   * whole-country box would return thousands of PlanetScope strips that nobody
   * can pick through. The cap keeps a search answerable.
   */
  maxAreaSqKm: number
  /** Cloud cover ceiling the search starts with, 0-100. The user can change it. */
  defaultMaxCloudPercent: number
  /** How far back the initial date range reaches, in days. */
  defaultLookbackDays: number
}

/**
 * The largest `maxAreaSqKm` a creator may set.
 *
 * A ceiling on the setting, not just a default, because the cost of getting it
 * wrong lands on the app user rather than the person who typed it. A scene
 * search returns every PlanetScope strip intersecting the box and builds one
 * tile layer per day; past a few thousand square kilometres that is a result
 * list nobody can work through and a tile bill nobody intended. Enforced in the
 * settings panel and again when the runtime reads the config, so a value edited
 * by hand or carried over from an older app is clamped rather than honoured.
 */
export const MAX_CONFIGURABLE_AREA_SQ_KM = 2500

export const DEFAULT_SCENES_CONFIG: ScenesConfig = {
  maxAreaSqKm: 500,
  defaultMaxCloudPercent: 20,
  defaultLookbackDays: 30
}
