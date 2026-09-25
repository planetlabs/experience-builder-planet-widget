import { type PlanetMosaic } from './types'

export interface Renderer {
  value: string
  label: string
}

/** Sentinel value for "let Planet pick the default visualisation". */
export const DEFAULT_RENDERER = 'default'

/**
 * Planet's `proc=` visualisations.
 *
 * There is no API endpoint that enumerates these, so the list mirrors the Tile
 * Services documentation and has to be extended by hand if Planet publishes a
 * new index:
 * https://docs.planet.com/develop/apis/tiles/#remote-sensing-indices
 */
export const INDEX_RENDERERS: Renderer[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'cir', label: 'Color infrared (CIR)' },
  { value: 'ndvi', label: 'NDVI — vegetation' },
  { value: 'ndwi', label: 'NDWI — water' },
  { value: 'vari', label: 'VARI — atmospheric resistance' },
  { value: 'msavi2', label: 'MSAVI2 — soil adjusted' },
  { value: 'mtvi2', label: 'MTVI2 — triangular vegetation' },
  { value: 'tgi', label: 'TGI — triangular greenness' }
]

/**
 * Whether a mosaic accepts `proc=` index rendering.
 *
 * Planet only renders false-colour indices for Surface Reflectance mosaics.
 * Those stream 16-bit data, so `datatype` separates them from 8-bit visual
 * mosaics; the name check is a fallback for responses that omit the field.
 */
export function supportsIndices (mosaic: Pick<PlanetMosaic, 'datatype' | 'name'>): boolean {
  const datatype = mosaic?.datatype?.toLowerCase()
  if (datatype) {
    return datatype !== 'uint8' && datatype !== 'byte'
  }
  return /normalized_analytic|analytic/.test(mosaic?.name ?? '')
}

/** Renderer choices for an item, including the "default" entry. */
export function renderersFor (supportsIdx: boolean): Renderer[] {
  const base: Renderer[] = [{ value: DEFAULT_RENDERER, label: 'Default (as published)' }]
  return supportsIdx ? base.concat(INDEX_RENDERERS) : base
}
