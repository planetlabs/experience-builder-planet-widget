import {
  AbstractDataAction, DataLevel, MutableStoreManager, getAppStore,
  type DataRecordSet
} from 'jimu-core'

/**
 * Where the chosen geometry is handed to the widget.
 *
 * A data action runs outside the React tree, so it cannot call into the widget
 * directly. `MutableStoreManager` is the framework's channel for exactly this:
 * the value lands on the widget's `mutableStateProps` and re-renders it.
 */
export const SEARCH_AREA_STATE_KEY = 'featureSearchArea'

/** What the runtime receives. The geometry is left in the map's own spatial reference. */
export interface FeatureSearchArea {
  /** An Esri Polygon or the REST JSON equivalent: both carry `rings`. */
  geometry: any
  /** Shown in the widget so the user can see which feature is driving the search. */
  label: string
  /**
   * Bumped on every execution.
   *
   * Choosing the same feature twice has to take effect the second time - after
   * clearing the area, say - and an unchanged geometry object would otherwise
   * look like nothing had happened.
   */
  stamp: number
}

/**
 * Adds "Search Planet imagery here" to a feature's Actions menu.
 *
 * Only offered for a single polygon: a point or a line has no area to search,
 * and combining several selected features would mean guessing at ring winding
 * order to tell separate parts from holes. One feature, one search area.
 */
export default class UseAsSearchArea extends AbstractDataAction {
  async isSupported (dataSets: DataRecordSet[], dataLevel: DataLevel): Promise<boolean> {
    if (dataLevel !== DataLevel.Records) return false

    // Only this widget's own scene search can use an area. An instance
    // configured for mosaics or tasking must not clutter every popup.
    if (getWidgetMode(this.widgetId) !== 'scenes') return false

    return pickSearchable(dataSets) !== null
  }

  async onExecute (dataSets: DataRecordSet[]): Promise<boolean> {
    const dataSet = pickSearchable(dataSets)
    if (!dataSet) return false

    const payload: FeatureSearchArea = {
      geometry: readGeometry(dataSet.records[0]),
      label: readLabel(dataSet),
      stamp: Date.now()
    }
    MutableStoreManager.getInstance().updateStateValue(this.widgetId, SEARCH_AREA_STATE_KEY, payload)
    return true
  }
}

/**
 * The one record set this action can search, or null when none qualifies.
 *
 * Not `dataSets[0]`. A popup can carry several: the case that surfaced it was
 * the same layer added to a map twice, where a click lands on both copies and
 * Experience Builder offers the action a set per layer. Requiring exactly one
 * in the list made the action disappear from precisely the situation where the
 * user has the feature in front of them - while the built-in actions, which
 * cope with several, carried on and made it look like ours was broken.
 *
 * Searching what is there beats insisting on how it arrived, so this looks for
 * a set that can actually be searched rather than assuming the first one is it.
 * That also makes the check robust to *which* of the shape gates the host trips
 * on a duplicate, which is not worth pinning down when the answer is the same
 * either way.
 *
 * Still one feature per set: several records are skipped rather than combined,
 * because merging polygons would mean guessing at winding order to tell
 * separate parts from holes. Where more than one set qualifies the first wins -
 * with a duplicated layer they describe the same ground, and the chosen area is
 * drawn on the map where a wrong guess is visible and one click to clear.
 *
 * Shared by `isSupported` and `onExecute` so the two cannot disagree about what
 * they accept: a menu entry that appears and then does nothing is worse than
 * one that never appeared.
 */
function pickSearchable (dataSets: DataRecordSet[]): DataRecordSet | null {
  const usable = (dataSets ?? []).filter((dataSet) => (
    // 'current' is the feature open in a popup; 'selected' is a selection set.
    (dataSet?.type === 'current' || dataSet?.type === 'selected') &&
    dataSet.records?.length === 1 &&
    isPolygon(readGeometry(dataSet.records[0]))
  ))
  return usable[0] ?? null
}

/**
 * The record's geometry.
 *
 * `FeatureDataRecord.feature` is either an Esri `Graphic` or the REST `IFeature`
 * JSON, depending on where the record came from. Both expose `geometry`, and
 * both spell a polygon's outline `rings`, so nothing downstream has to care.
 */
function readGeometry (record: any): any {
  return record?.feature?.geometry ?? null
}

function isPolygon (geometry: any): boolean {
  return Array.isArray(geometry?.rings) && geometry.rings.length > 0
}

/**
 * A name for the feature, for the widget to show beside the area.
 *
 * `dataSet.name` is not it: the map popup sets that to "<layer> map current
 * record", which reads badly in a sentence like "X covers about 900 km2". The
 * layer's own display field is what the popup titles itself with, so it is what
 * the user will recognise.
 */
function readLabel (dataSet: DataRecordSet): string {
  const dataSource = dataSet.dataSource as any
  const layerName: string = dataSource?.getLabel?.() || ''
  const displayField: string = dataSource?.layerDefinition?.displayField

  const value = displayField
    ? dataSet.records?.[0]?.getFieldValue?.(displayField)
    : null
  const title = value === null || value === undefined ? '' : String(value).trim()

  if (title) return layerName ? `${layerName}: ${title}` : title
  return layerName || dataSet.name || 'Selected feature'
}

/**
 * The configured mode of the widget providing this action.
 *
 * Read from the app config rather than passed in: a data action is constructed
 * once and has no props, and the builder keeps its own copy of the config.
 */
function getWidgetMode (widgetId: string): string | undefined {
  const state = getAppStore().getState()
  const appConfig = window.jimuConfig?.isBuilder ? state?.appStateInBuilder?.appConfig : state?.appConfig
  return appConfig?.widgets?.[widgetId]?.config?.mode
}
