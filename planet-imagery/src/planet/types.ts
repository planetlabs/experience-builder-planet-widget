/** Shapes returned by the Planet APIs (only the fields this widget uses). */

export interface PlanetLinks {
  _self?: string
  _next?: string
  tiles?: string
  mosaics?: string
}

export interface PlanetSeries {
  id: string
  name: string
  description?: string
  _links?: PlanetLinks
}

export interface PlanetMosaic {
  id: string
  name: string
  /** ISO timestamp of the start of the mosaic's acquisition window. */
  first_acquired?: string
  /** ISO timestamp of the end of the mosaic's acquisition window. */
  last_acquired?: string
  /** 'uint8' for visual mosaics, 'uint16' for Surface Reflectance. */
  datatype?: string
  product_type?: string
  /** [xmin, ymin, xmax, ymax] in degrees. */
  bbox?: [number, number, number, number]
  /** Cadence, e.g. '1 mon'. */
  interval?: string
  level?: number
  _links?: PlanetLinks
}

/** A GeoJSON polygon, the only geometry this widget sends or reads. */
export interface GeoJsonPolygon {
  type: 'Polygon'
  /** Rings of [longitude, latitude] pairs, first ring the exterior. */
  coordinates: Array<Array<[number, number]>>
}

/**
 * A GeoJSON multi-polygon.
 *
 * Never produced by drawing, but a map feature chosen as the search area may
 * well be one: an island group, a split parcel, a district in two pieces.
 */
export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon'
  /** One entry per part, each a list of rings as in GeoJsonPolygon. */
  coordinates: Array<Array<Array<[number, number]>>>
}

/** Either polygon shape, as the Data API's geometry filter accepts. */
export type GeoJsonArea = GeoJsonPolygon | GeoJsonMultiPolygon

/**
 * One item from the Data API.
 *
 * Only PlanetScope (`PSScene`) is searched, so the fields here are the ones
 * every PSScene carries.
 */
export interface PlanetScene {
  id: string
  geometry?: GeoJsonPolygon
  properties?: {
    /** ISO timestamp of acquisition. */
    acquired?: string
    /** Fraction of the scene covered by cloud, 0-1. Not a percentage. */
    cloud_cover?: number
    item_type?: string
    /** 'standard' or 'test'. */
    quality_category?: string
    /** Ground sample distance in metres. */
    gsd?: number
    /** Satellite that took it, e.g. '2271'. */
    satellite_id?: string
    [key: string]: unknown
  }
}

/** Raised for non-2xx responses so callers can show the status to the user. */
export class PlanetApiError extends Error {
  readonly status: number

  constructor (status: number, message: string) {
    super(message)
    this.name = 'PlanetApiError'
    this.status = status
  }
}
