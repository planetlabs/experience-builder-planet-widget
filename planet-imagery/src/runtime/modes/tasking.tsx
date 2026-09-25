import { DataSourceManager, React } from 'jimu-core'
import { loadArcGISJSAPIModules } from 'jimu-arcgis'
import { Alert, Button, Checkbox, Label, TextInput } from 'jimu-ui'
import { buildTaskingDeepLink, type TaskingPoint } from '../../planet/tasking'
import { buildTaskedTileUrlTemplate } from '../../planet/taskedImagery'
import { type TaskedCapture } from '../../data-actions/loadTaskedImagery'
import { type ModeRuntimeProps } from './types'

interface Modules {
  Graphic: typeof __esri.Graphic
  GraphicsLayer: typeof __esri.GraphicsLayer
  GroupLayer: typeof __esri.GroupLayer
  WebTileLayer: typeof __esri.WebTileLayer
  Polygon: typeof __esri.Polygon
  projection: typeof __esri.projection
  SpatialReference: typeof __esri.SpatialReference
}

const MARKER_SYMBOL = {
  type: 'simple-marker' as const,
  color: [0, 122, 194, 0.35],
  size: 12,
  outline: { color: [255, 255, 255], width: 1.5 }
}

/**
 * The clipping shape.
 *
 * Only its alpha matters: `destination-in` keeps the pixels underneath wherever
 * this is opaque and discards the rest, so the colour is arbitrary and an
 * outline would only soften the edge.
 */
const MASK_SYMBOL = {
  type: 'simple-fill' as const,
  color: [0, 0, 0, 1],
  outline: null as unknown as undefined
}

/** One capture the user has loaded, in the order it was loaded. */
interface LoadedCapture extends Omit<TaskedCapture, 'stamp'> {
  visible: boolean
}

/**
 * Identity of a capture, for matching a loaded entry to its map layers.
 *
 * The id list rather than a single id, because a Pelican strip is several
 * scenes streamed as one layer. The item type is in there too: the same ids
 * under a different type are a different request.
 */
function captureKey (capture: { itemType: string, itemIds: string[] }): string {
  return `${capture.itemType}/${capture.itemIds.join(',')}`
}

export default function TaskingRuntime (props: ModeRuntimeProps): React.ReactElement {
  const { config, endpoints, jimuMapView, taskedCapture, useDataSources } = props
  const archiveEnabled = Boolean(config?.tasking?.archiveEnabled)
  const layerName = useLayerName(useDataSources, jimuMapView)

  const [modules, setModules] = React.useState<Modules>(null)
  const [selecting, setSelecting] = React.useState(false)
  const [point, setPoint] = React.useState<TaskingPoint>(null)
  const [error, setError] = React.useState<string>(null)

  const [captures, setCaptures] = React.useState<LoadedCapture[]>([])
  /** Inclusive `YYYY-MM-DD` bounds; empty means unbounded on that side. */
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')

  /** The parent group, rebuilt whenever the active view changes. */
  const [archiveGroup, setArchiveGroup] = React.useState<__esri.GroupLayer>(null)
  /** Item id to the child group holding that capture's tiles and its mask. */
  const groupsRef = React.useRef(new Map<string, __esri.GroupLayer>())

  React.useEffect(() => {
    let cancelled = false
    loadArcGISJSAPIModules([
      'esri/Graphic',
      'esri/layers/GraphicsLayer',
      'esri/layers/GroupLayer',
      'esri/layers/WebTileLayer',
      'esri/geometry/Polygon',
      'esri/geometry/projection',
      'esri/geometry/SpatialReference'
    ]).then(async ([
      Graphic, GraphicsLayer, GroupLayer, WebTileLayer, Polygon, projection, SpatialReference
    ]) => {
      // Needed before project() can be called against an arbitrary view.
      await projection.load()
      if (!cancelled) {
        setModules({ Graphic, GraphicsLayer, GroupLayer, WebTileLayer, Polygon, projection, SpatialReference })
      }
    }).catch((err) => {
      if (!cancelled) setError(err?.message ?? String(err))
    })
    return () => { cancelled = true }
  }, [])

  // A location picked against one map means nothing on another, and neither do
  // footprints loaded from a layer that view may not even have.
  React.useEffect(() => {
    setPoint(null)
    setSelecting(false)
    setCaptures([])
  }, [jimuMapView])

  /**
   * Clicks are only intercepted while the tool is armed, so the map keeps its
   * normal popup behaviour the rest of the time - which is what the archive
   * beta needs, since its own entry point is that popup.
   */
  React.useEffect(() => {
    const view = jimuMapView?.view
    if (!view || !modules || !selecting) return

    const container = view.container as HTMLElement
    const previousCursor = container?.style.cursor
    if (container) container.style.cursor = 'crosshair'

    const handle = view.on('click', (event) => {
      // Suppress the popup for the click that places the marker.
      event.stopPropagation()
      const located = toWgs84(event.mapPoint, modules)
      if (!located) {
        setError('Could not read that location. Try clicking somewhere else on the map.')
        return
      }
      setError(null)
      setPoint(located)
      setSelecting(false)
    })

    return () => {
      handle.remove()
      if (container) container.style.cursor = previousCursor ?? ''
    }
  }, [jimuMapView, modules, selecting])

  React.useEffect(() => {
    const view = jimuMapView?.view
    if (!view || !modules || !point) return

    const graphic = new modules.Graphic({
      geometry: {
        type: 'point',
        longitude: point.longitude,
        latitude: point.latitude
      } as unknown as __esri.Point,
      symbol: MARKER_SYMBOL as unknown as __esri.Symbol
    })
    view.graphics.add(graphic)

    return () => { view.graphics.remove(graphic) }
  }, [point, jimuMapView, modules])

  // --- Archive beta --------------------------------------------------------

  /**
   * A capture arriving from the "Load tasked imagery here" popup action.
   *
   * Keyed on the stamp rather than the capture itself, so loading the same one
   * twice after removing it works, while a re-render caused by anything else
   * does not re-add it.
   */
  const stamp = taskedCapture?.stamp
  React.useEffect(() => {
    if (!archiveEnabled || !taskedCapture) return
    const { stamp: _stamp, ...capture } = taskedCapture
    const key = captureKey(capture)
    setCaptures((current) => {
      // Already loaded: make sure it is visible rather than adding a duplicate
      // layer over the top of itself.
      if (current.some((entry) => captureKey(entry) === key)) {
        return current.map((entry) => (
          captureKey(entry) === key ? { ...entry, visible: true } : entry
        ))
      }
      return current.concat({ ...capture, visible: true })
    })
    setError(null)
    // taskedCapture is intentionally read through the stamp: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, archiveEnabled])

  // The parent group belongs to the view it was built against, so a view change
  // rebuilds it. Destroying it destroys the child groups with it, which is why
  // the ref is cleared here and nowhere else.
  React.useEffect(() => {
    const view = jimuMapView?.view
    if (!view || !modules || !archiveEnabled) return
    const groups = groupsRef.current

    const group = new modules.GroupLayer({ title: 'Planet tasked imagery', listMode: 'hide' })
    view.map.add(group)
    setArchiveGroup(group)

    return () => {
      setArchiveGroup(null)
      groups.clear()
      view.map?.remove(group)
      group.destroy()
    }
  }, [jimuMapView, modules, archiveEnabled])

  /**
   * Which loaded captures the date filter admits.
   *
   * A capture with no readable date is always shown: hiding it would make it
   * look as though the load had failed, when the only thing missing is a value
   * in the layer's date column.
   */
  const withinDateFilter = React.useCallback((capture: LoadedCapture): boolean => {
    if (!capture.date) return true
    if (dateFrom && capture.date < dateFrom) return false
    if (dateTo && capture.date > dateTo) return false
    return true
  }, [dateFrom, dateTo])

  /**
   * One child group per capture, each holding its tile layer and its own mask.
   *
   * A group per capture rather than one shared mask, because the footprints
   * differ: a single mask layer would keep any pixel under any footprint, so
   * one capture's overhang would show through another's outline.
   */
  React.useEffect(() => {
    if (!modules || !archiveGroup) return
    const groups = groupsRef.current

    const wanted = new Set(captures.map(captureKey))
    groups.forEach((group, key) => {
      if (wanted.has(key)) return
      archiveGroup.remove(group)
      group.destroy()
      groups.delete(key)
    })

    captures.forEach((capture) => {
      const key = captureKey(capture)
      const urlTemplate = buildTaskedTileUrlTemplate(capture.itemType, capture.itemIds, endpoints)
      const existing = groups.get(key)
      const visible = capture.visible && withinDateFilter(capture)

      if (existing) {
        const tiles = existing.layers.find(
          (layer) => layer.type === 'web-tile'
        ) as __esri.WebTileLayer
        // Rebuilt rather than retargeted only when the URL actually changes -
        // which it does when the credential does, as in a key swap at runtime.
        if (tiles && tiles.urlTemplate !== urlTemplate) tiles.urlTemplate = urlTemplate
        existing.visible = visible
        return
      }

      const footprint = toEsriPolygon(capture.geometry, modules, jimuMapView?.view?.spatialReference)
      const group = new modules.GroupLayer({
        title: captureTitle(capture),
        listMode: 'hide',
        visible
      })

      const tiles = new modules.WebTileLayer({
        urlTemplate,
        subDomains: endpoints.subDomains.length > 0 ? endpoints.subDomains : undefined,
        title: captureTitle(capture),
        copyright: 'Imagery (c) Planet Labs PBC',
        // The quota guard, and the reason the popup action insists on a
        // footprint: the view never asks for a tile outside this extent, so
        // panning away from the capture costs nothing.
        fullExtent: footprint?.extent ?? undefined
      })
      group.add(tiles)

      // Above the imagery, inside the group: trims the whole-tile overhang the
      // extent leaves behind, without the erasure reaching the basemap.
      const mask = new modules.GraphicsLayer({ listMode: 'hide', blendMode: 'destination-in' })
      if (footprint) {
        mask.add(new modules.Graphic({
          geometry: footprint,
          symbol: MASK_SYMBOL as unknown as __esri.Symbol
        }))
      }
      group.add(mask)

      groups.set(key, group)
      archiveGroup.add(group)
    })

    // Oldest first, so the most recent capture ends up drawn on top. Captures
    // with no date sort below everything dated, where they cannot hide one.
    const order = captures.slice().sort(
      (a, b) => (a.date ?? '').localeCompare(b.date ?? '')
    )
    order.forEach((capture) => {
      const group = groups.get(captureKey(capture))
      if (group) archiveGroup.reorder(group, archiveGroup.layers.length - 1)
    })

    archiveGroup.listMode = groups.size > 0 ? 'show' : 'hide'
    const map = jimuMapView?.view?.map
    if (map) map.reorder(archiveGroup, map.layers.length - 1)
  }, [captures, modules, archiveGroup, endpoints, withinDateFilter, jimuMapView])

  const href = point ? buildTaskingDeepLink(point) : null
  const hiddenByFilter = captures.filter((capture) => !withinDateFilter(capture)).length

  return (
    <div>
      <SectionHead title='Task new imagery' />

      {/* The button leads and the explanation follows it: the callout this
          replaced pushed the only control in the section below the fold. */}
      <Button
        className='mt-2'
        block
        type={selecting ? 'primary' : 'default'}
        disabled={!modules || !jimuMapView}
        onClick={() => { setSelecting((current) => !current) }}
      >
        {selecting ? 'Click the map to place a point' : 'Select location'}
      </Button>

      <div className='text-disabled mt-1' style={{ fontSize: 12 }}>
        Pick a location, then open it in the Planet tasking dashboard to finish the order.
        A tasking plan on your Planet account is required to submit one.
      </div>

      {error && <Alert className='mt-2' form='basic' type='error' withIcon text={error} />}

      {point && (
        <div className='mt-3'>
          <div style={{ fontSize: 12 }}>
            {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
          </div>
          <Button
            className='mt-2'
            block
            type='primary'
            tag='a'
            href={href}
            target='_blank'
            rel='noopener noreferrer'
          >
            Open tasking order
          </Button>
          <Button
            className='mt-1'
            block
            type='tertiary'
            onClick={() => { setPoint(null) }}
          >
            Clear
          </Button>
        </div>
      )}

      {archiveEnabled && (
        <div className='mt-4'>
          <SectionHead title='View high-res imagery' beta />

          {captures.length === 0
            ? (
              <div className='text-disabled mt-1' style={{ fontSize: 12 }}>
                Click a feature in {layerName ? <strong>{layerName}</strong> : 'the tasking layer'} on
                the map, then choose &ldquo;Load tasked imagery here&rdquo; from its Actions menu to
                stream what that task delivered.
              </div>
              )
            : (
              <>
                <div className='mt-2' style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TextInput
                    type='date'
                    size='sm'
                    value={dateFrom}
                    onChange={(evt) => { setDateFrom(evt.target.value) }}
                    aria-label='Show captures from'
                  />
                  <span className='text-disabled' style={{ fontSize: 12 }}>to</span>
                  <TextInput
                    type='date'
                    size='sm'
                    value={dateTo}
                    onChange={(evt) => { setDateTo(evt.target.value) }}
                    aria-label='Show captures until'
                  />
                </div>

                {hiddenByFilter > 0 && (
                  <div className='text-disabled mt-1' style={{ fontSize: 12 }}>
                    {hiddenByFilter} hidden by the date filter.
                  </div>
                )}

                <div className='mt-2'>
                  {captures.map((capture) => (
                    <CaptureRow
                      key={captureKey(capture)}
                      capture={capture}
                      filtered={!withinDateFilter(capture)}
                      onToggle={() => {
                        setCaptures((current) => current.map((entry) => (
                          captureKey(entry) === captureKey(capture)
                            ? { ...entry, visible: !entry.visible }
                            : entry
                        )))
                      }}
                      onRemove={() => {
                        setCaptures((current) => current.filter(
                          (entry) => captureKey(entry) !== captureKey(capture)
                        ))
                      }}
                    />
                  ))}
                </div>

                <Button
                  className='mt-1'
                  block
                  size='sm'
                  type='tertiary'
                  onClick={() => { setCaptures([]) }}
                >
                  Remove all
                </Button>
              </>
              )}
        </div>
      )}
    </div>
  )
}

/**
 * The two headings in this panel, so they cannot drift apart.
 *
 * Plain markup rather than a `SettingSection`-style component, because this is
 * the runtime panel: it has no settings furniture to match, only itself.
 */
function SectionHead (props: { title: string, beta?: boolean }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <strong style={{ fontSize: 13 }}>{props.title}</strong>
      {props.beta && (
        <span
          className='text-disabled'
          style={{ fontSize: 10, border: '1px solid currentColor', borderRadius: 3, padding: '0 4px' }}
        >
          BETA
        </span>
      )}
    </div>
  )
}

/**
 * The configured layer's name, for telling the user which features to click.
 *
 * Read from the data source rather than stored in the configuration, so
 * renaming the layer does not leave stale wording in the panel. The map widget
 * creates its layer data sources as the view loads, which is why a view change
 * re-reads it; until one exists the caller falls back to naming no layer.
 */
function useLayerName (
  useDataSources: ModeRuntimeProps['useDataSources'],
  jimuMapView: ModeRuntimeProps['jimuMapView']
): string {
  const [name, setName] = React.useState('')

  React.useEffect(() => {
    const dataSourceId = useDataSources?.[0]?.dataSourceId
    if (!dataSourceId) {
      setName('')
      return
    }
    setName(DataSourceManager.getInstance().getDataSource(dataSourceId)?.getLabel?.() ?? '')
  }, [useDataSources, jimuMapView])

  return name
}

interface CaptureRowProps {
  capture: LoadedCapture
  filtered: boolean
  onToggle: () => void
  onRemove: () => void
}

function CaptureRow (props: CaptureRowProps): React.ReactElement {
  const { capture, filtered, onToggle, onRemove } = props

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 0',
        opacity: filtered ? 0.5 : 1
      }}
    >
      <Label
        check
        style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, flex: '1 1 auto', minWidth: 0 }}
      >
        <Checkbox
          checked={capture.visible}
          disabled={filtered}
          onChange={onToggle}
          aria-label={`Show ${capture.label}`}
        />
        <span style={{ minWidth: 0 }}>
          <div
            style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={`${capture.itemType} ${capture.itemIds.join(', ')}`}
          >
            {capture.label}
          </div>
          <div className='text-disabled' style={{ fontSize: 11 }}>
            {capture.date ?? 'No date'} &middot; {capture.itemType}
            {capture.itemIds.length > 1 && ` · ${capture.itemIds.length} scenes`}
          </div>
        </span>
      </Label>
      <Button
        type='tertiary'
        size='sm'
        onClick={onRemove}
        aria-label={`Remove ${capture.label}`}
      >
        Remove
      </Button>
    </div>
  )
}

/**
 * Constellation name for an item type, for the map layer list.
 *
 * The item type itself is the wrong thing to show there - nobody scanning a
 * layer list wants to read `PelicanScene` - but it is what the tile URL needs,
 * so both exist side by side.
 */
function sensorName (itemType: string): string {
  if (itemType.startsWith('SkySat')) return 'SkySat'
  if (itemType.startsWith('Pelican')) return 'Pelican'
  return itemType
}

/**
 * The name this capture takes in the map's layer list.
 *
 * `Planet Pelican - 2026-09-10`: the brand, the constellation, the day. The
 * feature's own label is left out, because the layer that supplied it names its
 * rows much the same way and the two together read as a stutter. It comes back
 * only when there is no date, where it is all that separates one capture from
 * another.
 */
function captureTitle (capture: LoadedCapture): string {
  const sensor = `Planet ${sensorName(capture.itemType)}`
  return `${sensor} - ${capture.date ?? capture.label}`
}

/**
 * The feature's footprint as an Esri polygon in the view's spatial reference.
 *
 * Which projection it arrives in depends on who ran the data action. A map
 * popup hands over the graphic the view already drew, so it matches. A Table
 * widget queries the service itself and gets back whatever the service stores,
 * which for a hosted feature layer is usually WGS84.
 *
 * Projecting is therefore not optional, and the failure it prevents is a quiet
 * one: both the mask and `fullExtent` are read in view coordinates, so degrees
 * left unprojected describe a region a Web Mercator view never visits. The
 * layer then requests no tiles at all - no error, no network traffic, nothing
 * on the map.
 */
function toEsriPolygon (
  geometry: any,
  modules: Modules,
  viewSpatialReference: __esri.SpatialReference
): __esri.Polygon | null {
  if (!Array.isArray(geometry?.rings) || geometry.rings.length === 0) return null

  const polygon = geometry.type === 'polygon' && typeof geometry.clone === 'function'
    ? geometry as __esri.Polygon
    // Geometry with no spatial reference of its own is taken to be in the
    // view's, which is what the popup path has always supplied.
    : new modules.Polygon({
      rings: geometry.rings,
      spatialReference: geometry.spatialReference ?? viewSpatialReference
    })

  if (!viewSpatialReference || polygon.spatialReference?.equals(viewSpatialReference)) {
    return polygon
  }

  // Falling back to the unprojected polygon rather than to no footprint at
  // all: a wrong extent shows nothing, but no extent lets the layer request
  // tiles anywhere the user pans, which is the quota this bounding exists to
  // protect.
  return (modules.projection.project(polygon, viewSpatialReference) as __esri.Polygon) ?? polygon
}

/**
 * The view can be in any projection, so the clicked point is converted rather
 * than assumed to already carry a longitude and latitude.
 */
function toWgs84 (mapPoint: __esri.Point, modules: Modules): TaskingPoint | null {
  if (!mapPoint) return null
  if (mapPoint.spatialReference?.isWGS84) {
    return { longitude: mapPoint.x, latitude: mapPoint.y }
  }
  const projected = modules.projection.project(
    mapPoint, modules.SpatialReference.WGS84
  ) as __esri.Point
  return projected ? { longitude: projected.x, latitude: projected.y } : null
}
