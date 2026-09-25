import { type ImmutableArray, type UseDataSource } from 'jimu-core'
import { type PlanetEndpoints } from '../../planet/api'
import { type IMConfig } from '../../config'

/**
 * What every mode's settings panel receives.
 *
 * `onConfigChange` already carries the widget id, so a mode never has to know
 * how Experience Builder persists its config.
 */
export interface ModeSettingProps {
  config: IMConfig
  /** Resolved from the shared API key and proxy fields. */
  endpoints: PlanetEndpoints
  onConfigChange: (config: IMConfig) => void
  /**
   * Needed by the data source and field pickers, which resolve a layer's
   * schema through the widget rather than from the config.
   */
  widgetId: string
  /**
   * Layers this widget is bound to. Kept on the widget rather than in the
   * config because that is where Experience Builder expects it, and what makes
   * the framework load the data source and offer its fields.
   */
  useDataSources: ImmutableArray<UseDataSource>
  onUseDataSourcesChange: (useDataSources: UseDataSource[]) => void
}
