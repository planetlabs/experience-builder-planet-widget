import { type ImmutableArray, type UseDataSource } from 'jimu-core'
import { type JimuMapView } from 'jimu-arcgis'
import { type PlanetEndpoints } from '../../planet/api'
import { type IMConfig } from '../../config'
import { type FeatureSearchArea } from '../../data-actions/useAsSearchArea'
import { type TaskedCapture } from '../../data-actions/loadTaskedImagery'

/**
 * What every mode's runtime component receives.
 *
 * The shell owns the map widget binding and hands down the active view, so a
 * mode only deals with what it does to that view.
 */
export interface ModeRuntimeProps {
  config: IMConfig
  endpoints: PlanetEndpoints
  /** Null until the map widget has produced a view. */
  jimuMapView: JimuMapView
  /**
   * The layers the creator bound to this widget. Only tasking reads them, to
   * name the layer its imagery comes from.
   */
  useDataSources?: ImmutableArray<UseDataSource>
  /**
   * A polygon handed over by the widget's data action, or undefined until one
   * is. Only the scene search uses it; other modes ignore it.
   */
  featureArea?: FeatureSearchArea
  /**
   * A tasking capture handed over by the widget's other data action, or
   * undefined until one is. Only the tasking archive beta uses it.
   */
  taskedCapture?: TaskedCapture
}
