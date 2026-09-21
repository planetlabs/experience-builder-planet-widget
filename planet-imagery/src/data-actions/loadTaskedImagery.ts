import {
  AbstractDataAction, DataLevel, DataSourceStatus, MutableStoreManager, getAppStore,
  type DataRecordSet, type DataSource
} from 'jimu-core'
import { parseItemIds, resolveItemType, toIsoDate, type TaskedItemType } from '../planet/taskedImagery'

/**
 * Where a chosen tasking capture is handed to the widget.
 *
 * A data action runs outside the React tree, so it cannot call into the widget
 * directly. `MutableStoreManager` is the framework's channel for exactly this:
 * the value lands on the widget's `mutableStateProps` and re-renders it.
 */
export const TASKED_IMAGERY_STATE_KEY = 'taskedImagery'

/** What the runtime receives for one capture. */
export interface TaskedCapture {
  /**
   * The catalog items to stream as one capture.
   *
   * Usually one. A Pelican strip is several, because it has no Collect product
   * and streams as a comma-delimited list of its framed scenes.
   */
  itemIds: string[]
  /** From the layer's item type field, or inferred from the ids when SkySat. */
  itemType: TaskedItemType
  /** `YYYY-MM-DD` in UTC, or null when the date field is empty or unreadable. */
  date: string | null
  /**
   * The feature's footprint, in whatever spatial reference the record carried.
   *
   * A map popup hands over the view's; a Table widget hands over the service's.
   * The runtime projects it rather than assuming either.
   */
  geometry: any
  /** Shown in the widget beside the capture. */
  label: string
  /**
   * Bumped on every execution, so choosing the same capture twice after
   * removing it takes effect the second time.
   */
  stamp: number
}

/**
 * Adds "Load tasked imagery here" to a feature's Actions menu.
 *
 * Every condition below is a reason the action stays hidden rather than
 * appearing and failing. In particular it is scoped to the one layer the
 * creator configured: that layer is what decides which of the account's
 * captures app users can reach, so an action that offered itself on any
 * feature with a plausible id column would quietly undo the scoping.
 */
export default class LoadTaskedImagery extends AbstractDataAction {
  async isSupported (dataSets: DataRecordSet[], dataLevel: DataLevel): Promise<boolean> {
    if (dataLevel !== DataLevel.Records) return false

    const settings = readTaskingSettings(this.widgetId)
    if (!settings) return false

    return pickCapture(dataSets, settings) !== null
  }

  async onExecute (dataSets: DataRecordSet[]): Promise<boolean> {
    // Settings re-read and the whole check re-run rather than inherited from
    // `isSupported`. That decides whether to draw a menu item; this is what
    // actually streams, and the configured layer is the access boundary for the
    // mode - it is what scopes an app user to the captures the creator exposed.
    // A menu built before the creator repointed the layer would otherwise still
    // work against the old one.
    const settings = readTaskingSettings(this.widgetId)
    if (!settings) return false

    const dataSet = pickCapture(dataSets, settings)
    if (!dataSet) return false

    const record = dataSet.records[0]
    const itemType = readItemType(record, settings)
    const geometry = readGeometry(record)

    const payload: TaskedCapture = {
      itemIds: parseItemIds(record?.getFieldValue?.(settings.itemIdField)),
      itemType,
      date: settings.dateField ? toIsoDate(record?.getFieldValue?.(settings.dateField)) : null,
      geometry,
      label: readLabel(dataSet),
      stamp: Date.now()
    }
    MutableStoreManager.getInstance().updateStateValue(this.widgetId, TASKED_IMAGERY_STATE_KEY, payload)
    return true
  }
}

interface TaskingSettings {
  itemIdField: string
  itemTypeField?: string
  dateField?: string
  /** Data source and main data source ids of the configured layer. */
  dataSourceIds: Set<string>
}

/**
 * The one record set this action can stream, or null when none qualifies.
 *
 * Searches the list rather than taking `dataSets[0]`, for the reason the scene
 * search does: a popup can carry a set per layer, and the same layer added to a
 * map twice puts two in front of the action. Here the configured layer settles
 * any ambiguity by itself - only sets from it qualify at all, which is the
 * access boundary doing double duty as a disambiguator.
 *
 * Shared by `isSupported` and `onExecute`, so the function that draws the menu
 * entry and the function that acts on it cannot disagree about what they accept.
 */
function pickCapture (dataSets: DataRecordSet[], settings: TaskingSettings): DataRecordSet | null {
  const usable = (dataSets ?? []).filter((dataSet) => {
    // 'current' is the feature open in a popup; 'selected' is a selection set.
    if (dataSet?.type !== 'current' && dataSet?.type !== 'selected') return false
    if (dataSet.records?.length !== 1) return false

    const dataSource = dataSet.dataSource as DataSource & { supportSpatialInfo?: () => boolean }
    if (!dataSource || dataSource.getStatus() === DataSourceStatus.NotReady) return false
    if (!dataSource.supportSpatialInfo?.()) return false
    if (!isConfiguredLayer(dataSource, settings.dataSourceIds)) return false

    // A footprint is required, not decorative: it bounds which tiles the layer
    // is allowed to request, and without it a pan anywhere would spend quota.
    if (!isPolygon(readGeometry(dataSet.records[0]))) return false

    return readItemType(dataSet.records[0], settings) !== null
  })
  return usable[0] ?? null
}

/**
 * The configuration of the widget providing this action, or null when the
 * action should not appear at all.
 *
 * Read from the app config rather than passed in: a data action is constructed
 * once and has no props, and the builder keeps its own copy of the config.
 */
function readTaskingSettings (widgetId: string): TaskingSettings | null {
  const state = getAppStore().getState()
  const appConfig = window.jimuConfig?.isBuilder ? state?.appStateInBuilder?.appConfig : state?.appConfig
  const widget = appConfig?.widgets?.[widgetId]

  if (widget?.config?.mode !== 'tasking') return null
  if (!widget?.config?.tasking?.archiveEnabled) return null

  const itemIdField: string = widget.config.tasking.itemIdField
  if (!itemIdField) return null

  // An enabled beta with no layer chosen is a half-finished configuration, not
  // an invitation to offer the action everywhere.
  const dataSourceIds = new Set<string>()
  for (const use of widget.useDataSources ?? []) {
    if (use?.dataSourceId) dataSourceIds.add(use.dataSourceId)
    if (use?.mainDataSourceId) dataSourceIds.add(use.mainDataSourceId)
  }
  if (dataSourceIds.size === 0) return null

  return {
    itemIdField,
    itemTypeField: widget.config.tasking.itemTypeField,
    dateField: widget.config.tasking.dateField,
    dataSourceIds
  }
}

/**
 * What to stream this record as, or null when the record cannot be streamed.
 *
 * Both halves come off the record: the ids, and the item type when the layer
 * carries one. Without an item type field this only resolves for SkySat, whose
 * ids name their own type - which is the whole reason the field is optional.
 */
function readItemType (record: any, settings: TaskingSettings): TaskedItemType | null {
  const itemIds = parseItemIds(record?.getFieldValue?.(settings.itemIdField))
  const declared = settings.itemTypeField
    ? record?.getFieldValue?.(settings.itemTypeField)
    : null
  return resolveItemType(declared, itemIds)
}

/**
 * Whether these records came from the layer the creator configured.
 *
 * Both the data source's own id and its main data source are checked, because
 * a popup hands over whichever view of the layer it is showing while the
 * settings panel records the layer the creator picked, and those are not always
 * spelled the same.
 */
function isConfiguredLayer (dataSource: DataSource, configured: Set<string>): boolean {
  const candidates = [
    dataSource.id,
    (dataSource as any).getMainDataSource?.()?.id,
    (dataSource as any).getRootDataSource?.()?.id
  ]
  return candidates.some((id) => id && configured.has(id))
}

/**
 * The record's geometry.
 *
 * `FeatureDataRecord.feature` is either an Esri `Graphic` or the REST `IFeature`
 * JSON, depending on where the record came from. Both expose `geometry`, and
 * both spell a polygon's outline `rings`.
 */
function readGeometry (record: any): any {
  return record?.feature?.geometry ?? null
}

function isPolygon (geometry: any): boolean {
  return Array.isArray(geometry?.rings) && geometry.rings.length > 0
}

/**
 * A name for the capture, for the widget to show beside it.
 *
 * `dataSet.name` is not it: the map popup sets that to "<layer> map current
 * record". The layer's own display field is what the popup titles itself with,
 * so it is what the user will recognise.
 */
function readLabel (dataSet: DataRecordSet): string {
  const dataSource = dataSet.dataSource as any
  const displayField: string = dataSource?.layerDefinition?.displayField

  const value = displayField
    ? dataSet.records?.[0]?.getFieldValue?.(displayField)
    : null
  const title = value === null || value === undefined ? '' : String(value).trim()

  return title || dataSource?.getLabel?.() || 'Tasked capture'
}
