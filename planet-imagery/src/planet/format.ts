import { type PlanetMosaic } from './types'

function isoDate (value?: string): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (isNaN(parsed)) return null
  return new Date(parsed).toISOString().slice(0, 10)
}

/**
 * Human label for one timestep.
 *
 * Mosaics cover a window rather than an instant, so the acquisition range is
 * more honest than a single date. Falls back to the mosaic name, which
 * normally encodes the period anyway (`global_monthly_2024_01_mosaic`).
 */
export function formatMosaicLabel (mosaic: PlanetMosaic): string {
  const start = isoDate(mosaic?.first_acquired)
  const end = isoDate(mosaic?.last_acquired)
  if (start && end && start !== end) return `${start} to ${end}`
  return start ?? mosaic?.name ?? mosaic?.id ?? ''
}
