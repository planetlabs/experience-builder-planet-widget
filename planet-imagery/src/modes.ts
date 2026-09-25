import { type IMConfig, type PlanetMode } from './config'

export interface ModeDefinition {
  id: PlanetMode
  label: string
  description: string
  /**
   * Whether the mode always needs an API key or proxy URL.
   *
   * Ask `needsPlanetConnection` rather than reading this directly: tasking
   * answers differently depending on how it is configured.
   */
  usesPlanetConnection: boolean
  implemented: boolean
  /**
   * Withheld from the setup UI while still resolvable, so an instance already
   * configured with the mode keeps working and nothing needs migrating.
   */
  hidden?: boolean
}

export const MODES: ModeDefinition[] = [
  {
    id: 'mosaics',
    label: 'Planet mosaics',
    description: 'Browse Planet mosaic series, step through dates, and add them to the map as tile layers.',
    usesPlanetConnection: true,
    implemented: true
  },
  {
    id: 'tasking',
    label: 'Tasking',
    description: 'Pick a location on the map and open a pre-filled tasking order in the Planet dashboard.',
    // The deep link carries no credentials; the dashboard authenticates the
    // user itself. The archive beta does need one - see needsPlanetConnection.
    usesPlanetConnection: false,
    implemented: true
  },
  {
    id: 'scenes',
    label: 'Daily scenes',
    description: 'Search PlanetScope imagery by area, date and cloud cover, then stream whole days to the map.',
    usesPlanetConnection: true,
    implemented: true
  }
]

/** The modes a creator can pick during setup. */
export const VISIBLE_MODES = MODES.filter((mode) => !mode.hidden)

export function getMode (id: PlanetMode): ModeDefinition | undefined {
  return MODES.find((mode) => mode.id === id)
}

/**
 * Whether this particular instance needs a Planet credential.
 *
 * Almost always a property of the mode alone, but tasking straddles the line:
 * handing a location to the dashboard needs nothing, while streaming imagery
 * from a past order is tile requests like any other. So the question is asked
 * of the configuration, not just the mode, and the settings panel and the
 * runtime both route through here rather than each deciding for themselves.
 */
export function needsPlanetConnection (definition: ModeDefinition, config: IMConfig): boolean {
  if (definition.usesPlanetConnection) return true
  return definition.id === 'tasking' && Boolean(config?.tasking?.archiveEnabled)
}
