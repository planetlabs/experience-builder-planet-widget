import { React } from 'jimu-core'
import { loadArcGISJSAPIModules } from 'jimu-arcgis'
import { Alert, Button, Loading } from 'jimu-ui'
import { buildSceneTileUrlTemplate, groupByDate, searchScenes, SCENE_ITEM_TYPE } from '../../planet/scenes'
import {
  addDaysUtc, exclusiveEnd, nextSearchWindow, startOfDayUtc, toDateInputValue
} from '../../shared/dateWindows'
import { type GeoJsonArea, type PlanetScene } from '../../planet/types'
import { DEFAULT_SCENES_CONFIG, MAX_CONFIGURABLE_AREA_SQ_KM, type ScenesConfig } from '../../config'
import SceneSearchForm, { type SceneFilters } from '../sceneSearchForm'
import SceneDateGroupItem from '../sceneDateGroupItem'
import { type ModeRuntimeProps } from './types'

/** Web Mercator cannot represent the poles, so a bbox has to be clipped. */
const MERCATOR_MAX_LAT = 85.05112878

/**
 * The most points a search geometry may carry.
 *
 * A drawn rectangle has five. A real map feature - a county, a watershed, a
 * coastline - can carry tens of thousands, and every one of them goes into the
 * search body. Anything over this is generalized first.
 */
const MAX_VERTICES = 1500

/**
 * When to warn that the bounding box is much bigger than the feature.
 *
 * Tiles are culled against the box, not the outline, so a long thin shape
 * fetches far more imagery than it shows. Three times over is where that stops
 * being a rounding error.
 */
const BBOX_WARN_RATIO = 3

/** Shown only while the box is being dragged, where a fill reads as "this much". */
const AREA_DRAW_SYMBOL = {
  type: 'simple-fill' as const,
  color: [0, 122, 194, 0.08],
  outline: { color: [0, 122, 194], width: 2 }
}

/**
 * The accepted box, drawn over the imagery.
 *
 * No fill: even eight percent of blue tints every pixel underneath it, which is
 * exactly the imagery the box exists to frame.
 */
const AREA_SYMBOL = {
  type: 'simple-fill' as const,
  color: [0, 0, 0, 0],
  outline: { color: [0, 122, 194], width: 2 }
}

const FOOTPRINT_SYMBOL = {
  type: 'simple-fill' as const,
  color: [255, 190, 0, 0.15],
  outline: { color: [255, 190, 0], width: 1.5 }
}

/**
 * The clipping shape.
 *
 * Only its alpha matters: `destination-in` keeps the pixels underneath wherever
 * this is opaque and discards the rest, so the colour is arbitrary and the
 * outline would only soften the edge.
 */
const MASK_SYMBOL = {
  type: 'simple-fill' as const,
  color: [0, 0, 0, 1],
  outline: null as unknown as undefined
}

interface Modules {
  WebTileLayer: typeof __esri.WebTileLayer
  GraphicsLayer: typeof __esri.GraphicsLayer
  GroupLayer: typeof __esri.GroupLayer
  SketchViewModel: typeof __esri.SketchViewModel
  Graphic: typeof __esri.Graphic
  Extent: typeof __esri.Extent
  Polygon: typeof __esri.Polygon
  geometryEngine: typeof __esri.geometryEngine
  projection: typeof __esri.projection
  SpatialReference: typeof __esri.SpatialReference
}

/** The active search area, kept in WGS84 because that is what Planet wants. */
interface SearchArea {
  polygon: GeoJsonArea
  sqKm: number
  bbox: [number, number, number, number]
  /** The feature it came from, or null when it was drawn. */
  label: string | null
  /** Anything the user should know about it, shown under the form. */
  note: string | null
}

/** Per-view objects that have to be rebuilt when the active map view changes. */
interface MapKit {
  /** Holds the scene layers and the mask, so the clip cannot escape it. */
  groupLayer: __esri.GroupLayer
  /** Inside the group, above the imagery: the shape the imagery is kept within. */
  maskLayer: __esri.GraphicsLayer
  /** Outside the group: the search box outline and hover footprints. */
  graphicsLayer: __esri.GraphicsLayer
  sketch: __esri.SketchViewModel
}

export default function ScenesRuntime (props: ModeRuntimeProps): React.ReactElement {
  const { config, endpoints, jimuMapView, featureArea } = props
  const { tilesOrigin, apiKey, apiOrigin } = endpoints

  const settings: ScenesConfig = React.useMemo(() => {
    const configured = {
      ...DEFAULT_SCENES_CONFIG,
      ...(config?.scenes ? config.scenes.asMutable({ deep: true }) : {})
    }
    // Clamped rather than trusted: the settings panel enforces the ceiling for
    // anything configured today, but an app built before it existed, or a
    // config edited by hand, would otherwise hand an app user an unbounded
    // search.
    return {
      ...configured,
      maxAreaSqKm: Math.min(configured.maxAreaSqKm, MAX_CONFIGURABLE_AREA_SQ_KM)
    }
  }, [config?.scenes])

  const [modules, setModules] = React.useState<Modules>(null)
  const [mapKit, setMapKit] = React.useState<MapKit>(null)
  const [moduleError, setModuleError] = React.useState<string>(null)

  const [filters, setFilters] = React.useState<SceneFilters>(() => defaultFilters(settings))
  const [drawing, setDrawing] = React.useState(false)
  const [area, setArea] = React.useState<SearchArea>(null)
  const [areaError, setAreaError] = React.useState<string>(null)

  const [scenes, setScenes] = React.useState<PlanetScene[]>([])
  const [searching, setSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string>(null)
  const [truncated, setTruncated] = React.useState(false)
  /** Exclusive upper bound of the next window; null before the first search. */
  const [cursor, setCursor] = React.useState<Date>(null)
  /**
   * The filters the listed results were actually fetched with.
   *
   * Held separately from the live form so that editing a filter does not
   * silently change what "Load the previous month" means: an extra month
   * fetched under a different cloud ceiling would sit in the same list as the
   * months above it and read as one result set.
   */
  const [applied, setApplied] = React.useState<SceneFilters>(null)

  const [selectionByDate, setSelectionByDate] = React.useState<{ [date: string]: string[] }>({})
  const [preview, setPreview] = React.useState<PlanetScene>(null)

  const layersRef = React.useRef(new Map<string, __esri.WebTileLayer>())
  const searchAbortRef = React.useRef<AbortController>(null)
  /**
   * Set when an area arrives from the data action, so the search runs itself.
   *
   * A ref rather than state: it is read once by the effect below and must not
   * cause a render of its own, or the search would be queued twice.
   */
  const autoSearchRef = React.useRef(false)

  React.useEffect(() => {
    let cancelled = false
    loadArcGISJSAPIModules([
      'esri/layers/WebTileLayer',
      'esri/layers/GraphicsLayer',
      'esri/layers/GroupLayer',
      'esri/widgets/Sketch/SketchViewModel',
      'esri/Graphic',
      'esri/geometry/Extent',
      'esri/geometry/Polygon',
      'esri/geometry/geometryEngine',
      'esri/geometry/projection',
      'esri/geometry/SpatialReference'
    ]).then(async ([
      WebTileLayer, GraphicsLayer, GroupLayer, SketchViewModel, Graphic,
      Extent, Polygon, geometryEngine, projection, SpatialReference
    ]) => {
      // Needed before project() can be called against an arbitrary view.
      await projection.load()
      if (cancelled) return
      setModules({
        WebTileLayer,
        GraphicsLayer,
        GroupLayer,
        SketchViewModel,
        Graphic,
        Extent,
        Polygon,
        geometryEngine,
        projection,
        SpatialReference
      })
    }).catch((err) => {
      // The detail goes to the console for support; the panel gets the one
      // thing the user can act on.
      console.error('Planet imagery: could not load the ArcGIS modules', err)
      if (!cancelled) setModuleError(err?.message ?? String(err))
    })
    return () => { cancelled = true }
  }, [])

  // The group, the mask, the outline layer and the sketch model all belong to
  // the view they were built against, so a view change rebuilds rather than
  // reuses them. This effect also owns tearing the scene layers down, because
  // destroying the group destroys its children and nothing else may run after.
  React.useEffect(() => {
    const view = jimuMapView?.view
    if (!view || !modules) return
    // Captured rather than read in the cleanup: the Map itself never changes
    // identity, and reading `.current` later is what the lint warns about.
    const layers = layersRef.current

    // `destination-in` keeps what is already painted beneath this layer only
    // where this layer is opaque. A GroupLayer composites its children in
    // isolation, so the erasure stops at the Planet imagery and never reaches
    // the basemap. An empty mask therefore hides the group entirely, which is
    // the right failure: no drawn box means nothing to show imagery inside.
    const maskLayer = new modules.GraphicsLayer({
      listMode: 'hide',
      blendMode: 'destination-in'
    })
    const groupLayer = new modules.GroupLayer({ title: 'PlanetScope scenes', listMode: 'hide' })
    groupLayer.add(maskLayer)

    const graphicsLayer = new modules.GraphicsLayer({ listMode: 'hide' })
    view.map.addMany([groupLayer, graphicsLayer])

    const sketch = new modules.SketchViewModel({
      view: view as __esri.SketchViewModelProperties['view'],
      layer: graphicsLayer,
      updateOnGraphicClick: false,
      polygonSymbol: AREA_DRAW_SYMBOL as unknown as __esri.SimpleFillSymbol
    })
    setMapKit({ groupLayer, maskLayer, graphicsLayer, sketch })

    return () => {
      setMapKit(null)
      setDrawing(false)
      sketch.cancel()
      sketch.destroy()
      // Cleared before the group goes: destroying a group destroys the layers
      // in it, and a dead layer left in the ref would be handed back out by the
      // sync below as though it were still on the map.
      layers.clear()
      view.map?.remove(groupLayer)
      groupLayer.destroy()
      view.map?.remove(graphicsLayer)
      graphicsLayer.destroy()
    }
  }, [jimuMapView, modules])

  /**
   * The drawn box in the spatial reference the tile layers use.
   *
   * This is the part that saves quota. Handed to each scene layer as
   * `fullExtent`, it stops the view asking for tiles that do not intersect the
   * box, so panning or zooming anywhere else costs Planet nothing. It culls
   * whole tiles, so imagery still overhangs the box by up to one tile - about
   * 4.9 km at zoom 13, 300 m at zoom 17 - and the mask trims that overhang
   * visually without changing what is requested.
   */
  const clipExtent = React.useMemo(() => {
    if (!area || !modules) return null
    const wgs84 = new modules.Extent({
      xmin: area.bbox[0],
      ymin: Math.max(area.bbox[1], -MERCATOR_MAX_LAT),
      xmax: area.bbox[2],
      ymax: Math.min(area.bbox[3], MERCATOR_MAX_LAT),
      spatialReference: modules.SpatialReference.WGS84
    })
    return modules.projection.project(wgs84, modules.SpatialReference.WebMercator) as __esri.Extent
  }, [area, modules])

  /**
   * One tile layer per acquisition day, holding every scene selected for that
   * day. Planet composites a comma-separated id list server-side, so a day is
   * one layer and one tile request however many strips it took.
   */
  React.useEffect(() => {
    const map = jimuMapView?.view?.map
    const group = mapKit?.groupLayer
    if (!map || !modules || !group) return
    const layers = layersRef.current

    layers.forEach((layer, date) => {
      if (!selectionByDate[date]?.length) {
        group.remove(layer)
        layers.delete(date)
      }
    })

    Object.entries(selectionByDate).forEach(([date, ids]) => {
      if (!ids?.length) return
      const urlTemplate = buildSceneTileUrlTemplate(ids, endpoints)
      const previous = layers.get(date)
      // The layer is rebuilt rather than retargeted, because already-fetched
      // tiles would otherwise stay on screen after a scene is deselected.
      if (previous?.urlTemplate === urlTemplate) {
        if (clipExtent) previous.fullExtent = clipExtent
        return
      }

      const layer = new modules.WebTileLayer({
        urlTemplate,
        subDomains: endpoints.subDomains.length > 0 ? endpoints.subDomains : undefined,
        title: `PlanetScope ${date}${ids.length > 1 ? ` (${ids.length} scenes)` : ''}`,
        copyright: 'Imagery © Planet Labs PBC',
        // Set at construction so the very first draw is already bounded and no
        // tile outside the search area is ever requested.
        fullExtent: clipExtent ?? undefined
      })
      layers.set(date, layer)
      group.add(layer)
      if (previous) group.remove(previous)
    })

    // Oldest first, so the most recent day ends up on top of the imagery...
    Array.from(layers.keys()).sort().forEach((date) => {
      group.reorder(layers.get(date), group.layers.length - 1)
    })
    // ...and the mask sits above all of it, clipping only what is in the group.
    group.reorder(mapKit.maskLayer, group.layers.length - 1)
    // An empty group is noise in the layer list; a populated one is useful.
    group.listMode = layers.size > 0 ? 'show' : 'hide'

    map.reorder(group, map.layers.length - 1)
    // The search area outline is a reference, not imagery: it stays above.
    map.reorder(mapKit.graphicsLayer, map.layers.length - 1)
  }, [selectionByDate, jimuMapView, modules, mapKit, endpoints, tilesOrigin, apiKey, clipExtent])

  // The search area is drawn twice from one geometry: an outline the user sees,
  // and an opaque copy in the mask layer that the imagery is clipped to.
  React.useEffect(() => {
    if (!mapKit || !modules || !area) return
    const geometry = toEsriPolygon(area.polygon, modules)
    const outline = new modules.Graphic({
      geometry,
      symbol: AREA_SYMBOL as unknown as __esri.Symbol
    })
    const mask = new modules.Graphic({
      geometry,
      symbol: MASK_SYMBOL as unknown as __esri.Symbol
    })
    mapKit.graphicsLayer.add(outline)
    mapKit.maskLayer.add(mask)
    return () => {
      mapKit.graphicsLayer.remove(outline)
      mapKit.maskLayer.remove(mask)
    }
  }, [area, mapKit, modules])

  React.useEffect(() => {
    if (!mapKit || !modules || !preview?.geometry) return
    const graphic = new modules.Graphic({
      geometry: toEsriPolygon(preview.geometry, modules),
      symbol: FOOTPRINT_SYMBOL as unknown as __esri.Symbol
    })
    mapKit.graphicsLayer.add(graphic)
    return () => { mapKit.graphicsLayer.remove(graphic) }
  }, [preview, mapKit, modules])

  React.useEffect(() => {
    return () => { searchAbortRef.current?.abort() }
  }, [])

  // A polygon handed over by the data action. It arrives in whatever spatial
  // reference the feature's layer uses, so it goes through exactly the same
  // projection, cap and vertex handling as a sketched box.
  //
  // Keyed on the stamp rather than the payload: choosing the same feature again
  // after clearing the area has to take effect, and an unchanged geometry would
  // otherwise look like nothing had happened.
  React.useEffect(() => {
    if (!featureArea || !modules) return
    const rings = featureArea.geometry?.rings
    if (!Array.isArray(rings) || rings.length === 0) {
      setAreaError('That feature has no outline to search.')
      return
    }

    adoptArea(new modules.Polygon({
      rings: rings as unknown as number[][][],
      spatialReference: featureArea.geometry.spatialReference ?? jimuMapView?.view?.spatialReference
    }), featureArea.label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureArea?.stamp, modules])

  const startDraw = () => {
    const sketch = mapKit?.sketch
    if (!sketch) return
    if (drawing) {
      sketch.cancel()
      setDrawing(false)
      return
    }

    setAreaError(null)
    setDrawing(true)
    const handle = sketch.on('create', (event) => {
      if (event.state === 'cancel') {
        handle.remove()
        setDrawing(false)
        return
      }
      if (event.state !== 'complete') return
      handle.remove()
      setDrawing(false)
      // The sketch adds its own graphic to the layer; the accepted area is
      // drawn separately by the effect above, so this one goes.
      mapKit.graphicsLayer.remove(event.graphic)
      adoptArea(event.graphic.geometry as __esri.Polygon, null)
    })
    sketch.create('rectangle')
  }

  /**
   * Measure a candidate area and either adopt it or reject it.
   *
   * Shared by the sketch tool and the data action. `label` names the feature it
   * came from, or is null for a drawn box; it steers the wording, because
   * "draw a smaller one" is no use to someone who clicked a parcel.
   *
   * Geodesic rather than planar area, because a planar measurement in Web
   * Mercator overstates by a factor of ten or more away from the equator, which
   * would turn the cap into a latitude-dependent lottery.
   */
  const adoptArea = (candidate: __esri.Polygon, label: string | null) => {
    if (!candidate || !modules) return
    const subject = label ?? 'That box'

    // Before the checks, not after them. Results belong to the area they were
    // found in, and picking a new feature retires them whether or not the new
    // one turns out to be searchable - leaving a list of dates under a
    // rejection notice reads as though they describe the thing just clicked.
    resetResults()

    const wgs84 = candidate.spatialReference?.isWGS84
      ? candidate
      : modules.projection.project(candidate, modules.SpatialReference.WGS84) as __esri.Polygon
    if (!wgs84?.extent) {
      setAreaError(`Could not convert ${label ?? 'the drawn box'} to latitude and longitude.`)
      return
    }

    const sqKm = Math.abs(modules.geometryEngine.geodesicArea(wgs84, 'square-kilometers'))
    if (sqKm > settings.maxAreaSqKm) {
      setAreaError(
        `${subject} covers about ${Math.round(sqKm).toLocaleString()} km², over the ` +
        `${settings.maxAreaSqKm.toLocaleString()} km² search limit. ` +
        (label ? 'Pick a smaller feature, or draw a box inside it.' : 'Draw a smaller one.')
      )
      return
    }

    // Only after the cap: a feature that is too big is rejected on the area it
    // actually has, not on a simplified version of it.
    const fitted = fitVertexBudget(wgs84, modules)
    const polygon = toGeoJson(fitted.polygon)
    const extent = fitted.polygon.extent
    if (!polygon || !extent) {
      setAreaError(`${subject} had no usable outline.`)
      return
    }

    setAreaError(null)
    // The menu entry says "Search Planet imagery here", so a feature searches
    // itself; a drawn box waits, because drawing is usually the first of
    // several adjustments rather than the last.
    autoSearchRef.current = label !== null
    setArea({
      polygon,
      sqKm,
      bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
      label,
      note: describeArea(fitted.generalized, sqKm, extent, modules)
    })
  }

  // `runSearch` reads the area from state, so it cannot be called from
  // adoptArea - the setArea above has not landed yet. This picks it up on the
  // render after instead. A rejected area never sets the flag, and a drawn one
  // clears it, so nothing searches that was not asked to.
  React.useEffect(() => {
    if (!area || !autoSearchRef.current) return
    autoSearchRef.current = false
    runSearch(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area])

  const clearArea = () => {
    setArea(null)
    setAreaError(null)
    resetResults()
  }

  const resetResults = () => {
    searchAbortRef.current?.abort()
    setScenes([])
    setSelectionByDate({})
    setCursor(null)
    setApplied(null)
    setSearchError(null)
    setTruncated(false)
  }

  /**
   * Search one month.
   *
   * `reset` starts a fresh range from the end date; otherwise the window walks
   * back from wherever the last one stopped. Windows abut exactly, so nothing
   * is searched twice and nothing is skipped.
   */
  const runSearch = (reset: boolean) => {
    if (!area) return
    // A "load more" continues the search that produced the list, not whatever
    // the form says now.
    const active = reset ? filters : applied
    if (!active) return
    const until = reset ? exclusiveEnd(active.endDate) : cursor
    if (!until) return
    const window = nextSearchWindow(active.startDate, until)
    if (!window) return

    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller

    setSearching(true)
    setSearchError(null)
    if (reset) {
      setScenes([])
      setSelectionByDate({})
      setTruncated(false)
    }

    searchScenes(endpoints, {
      geometry: area.polygon,
      acquiredGte: window.gte,
      acquiredLt: window.lt,
      maxCloudPercent: active.maxCloudPercent
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setScenes((current) => mergeScenes(reset ? [] : current, result.items))
      setCursor(new Date(window.gte))
      setApplied(active)
      if (result.truncated) setTruncated(true)
      setSearching(false)
    }).catch((err) => {
      if (controller.signal.aborted || err?.name === 'AbortError') return
      setSearchError(err?.message ?? String(err))
      setSearching(false)
    })
  }

  const zoomTo = (bbox: [number, number, number, number]) => {
    const view = jimuMapView?.view
    if (!view || !modules) return

    const extent = new modules.Extent({
      xmin: bbox[0],
      ymin: Math.max(bbox[1], -MERCATOR_MAX_LAT),
      xmax: bbox[2],
      ymax: Math.min(bbox[3], MERCATOR_MAX_LAT),
      spatialReference: modules.SpatialReference.WGS84
    })
    const target = view.spatialReference?.isWGS84
      ? extent
      : modules.projection.project(extent, view.spatialReference) as __esri.Extent
    if (!target) return

    view.goTo(target).catch((err) => {
      // goTo rejects when the user interrupts the animation; nothing to do.
      if (err?.name !== 'AbortError') console.error('Could not zoom to the imagery extent', err)
    })
  }

  const groups = React.useMemo(() => groupByDate(scenes), [scenes])
  const mapReady = Boolean(mapKit) && Boolean(jimuMapView)
  const searchedBackTo = cursor ? toDateInputValue(cursor) : null
  const exhausted = cursor && applied ? cursor <= startOfDayUtc(applied.startDate) : false
  const filtersChanged = Boolean(applied) && !sameFilters(applied, filters)
  const selectedCount = Object.values(selectionByDate).reduce((total, ids) => total + (ids?.length ?? 0), 0)

  // A search run against one key or proxy says nothing about another.
  React.useEffect(() => {
    resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, apiKey])

  if (moduleError) {
    return <Alert form='basic' type='error' withIcon text='Could not load the map tools. Refresh the page to try again.' />
  }

  return (
    // The form keeps its natural height and the results list below takes what
    // is left, so a short panel shrinks the list rather than pushing the button
    // under it out of reach. No min-height override here or on the block below:
    // the default floor is min-content, which is what stops a very short panel
    // clipping the form instead of letting the widget scroll.
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto' }}>
      <SceneSearchForm
        filters={filters}
        onFiltersChange={setFilters}
        drawing={drawing}
        areaSqKm={area?.sqKm ?? null}
        areaLabel={area?.label ?? null}
        maxAreaSqKm={settings.maxAreaSqKm}
        mapReady={mapReady}
        searching={searching}
        onDraw={startDraw}
        onClearArea={clearArea}
        onZoomToArea={() => { if (area) zoomTo(area.bbox) }}
        onSearch={() => { runSearch(true) }}
      />

      {areaError && <Alert className='mt-2' form='basic' type='warning' withIcon text={areaError} />}
      {area?.note && <Alert className='mt-2' form='basic' type='info' withIcon text={area.note} />}
      {searchError && <Alert className='mt-2' form='basic' type='error' withIcon text={searchError} />}

      {searching && <div className='mt-2'><Loading width={20} height={20} /></div>}

      {applied && !searching && (
        <div
          className='mt-3'
          style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto' }}
        >
          <div className='text-disabled' style={{ fontSize: 11 }}>
            {scenes.length === 0
              ? `No ${SCENE_ITEM_TYPE} scenes matched between ${searchedBackTo} and ${applied.endDate}.`
              : `${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'} across ${groups.length} ` +
                `${groups.length === 1 ? 'day' : 'days'}, back to ${searchedBackTo}.`}
            {selectedCount > 0 && ` ${selectedCount} on the map.`}
          </div>

          {truncated && (
            <Alert
              className='mt-1'
              form='basic'
              type='warning'
              withIcon
              text={'A month of results was cut short. Narrow the cloud ceiling or the search area to see all of them.'}
            />
          )}

          {groups.length > 0 && (
            <div
              className='mt-1'
              // The only flex item with a min-height below its content, so it
              // is the one that gives way when the panel is short.
              style={{ flex: '1 1 auto', minHeight: 100, overflowY: 'auto', overflowX: 'hidden' }}
            >
              {groups.map((group) => (
                <SceneDateGroupItem
                  key={group.date}
                  group={group}
                  selectedIds={selectionByDate[group.date] ?? []}
                  onSelectionChange={(date, ids) => {
                    setSelectionByDate((current) => ({ ...current, [date]: ids }))
                  }}
                  onZoom={zoomTo}
                  onPreview={setPreview}
                />
              ))}
            </div>
          )}

          {filtersChanged && (
            <div className='text-disabled mt-2' style={{ fontSize: 11 }}>
              The filters above have changed. These results are from the previous search;
              run it again to apply them.
            </div>
          )}

          {!exhausted && !filtersChanged && (
            <Button
              className='mt-2'
              block
              type='tertiary'
              disabled={searching}
              onClick={() => { runSearch(false) }}
            >
              Load the previous month
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function defaultFilters (settings: ScenesConfig): SceneFilters {
  const today = new Date()
  return {
    startDate: toDateInputValue(addDaysUtc(today, -Math.max(settings.defaultLookbackDays, 1))),
    endDate: toDateInputValue(today),
    maxCloudPercent: settings.defaultMaxCloudPercent
  }
}

function sameFilters (a: SceneFilters, b: SceneFilters): boolean {
  return a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.maxCloudPercent === b.maxCloudPercent
}

/** Append new scenes, dropping ids already held so a re-search cannot double up. */
function mergeScenes (current: PlanetScene[], incoming: PlanetScene[]): PlanetScene[] {
  const seen = new Set(current.map((scene) => scene.id))
  return current.concat(incoming.filter((scene) => scene.id && !seen.has(scene.id)))
}

/**
 * Esri polygon to GeoJSON, in WGS84.
 *
 * Esri keeps every ring of every part in one flat list and tells them apart by
 * winding: clockwise opens a new part, counter-clockwise is a hole in the part
 * before it. GeoJSON nests them instead, so the list is regrouped here. A
 * feature in two pieces becomes a MultiPolygon; anything else stays a Polygon.
 */
function toGeoJson (polygon: __esri.Polygon): GeoJsonArea | null {
  const parts: Array<Array<Array<[number, number]>>> = []

  for (const ring of polygon?.rings ?? []) {
    const closed = closeRing(ring)
    if (!closed) continue
    if (parts.length === 0 || polygon.isClockwise(ring)) parts.push([closed])
    else parts[parts.length - 1].push(closed)
  }

  if (parts.length === 0) return null
  if (parts.length === 1) return { type: 'Polygon', coordinates: parts[0] }
  return { type: 'MultiPolygon', coordinates: parts }
}

/** A ring as GeoJSON wants it: three points at least, the first repeated last. */
function closeRing (ring: number[][]): Array<[number, number]> | null {
  if (!ring || ring.length < 3) return null

  const coordinates: Array<[number, number]> = ring.map(([x, y]) => [x, y])
  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  // GeoJSON requires a closed ring; Esri rings usually are, but not always.
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([first[0], first[1]])
  return coordinates
}

/** Back to one Esri polygon, for the outline and the mask. */
function toEsriPolygon (area: GeoJsonArea, modules: Modules): __esri.Polygon {
  // Esri's flat ring list is exactly what the nesting was built from, so the
  // parts can simply be concatenated back together.
  const rings = area.type === 'MultiPolygon'
    ? area.coordinates.reduce<Array<Array<[number, number]>>>((all, part) => all.concat(part), [])
    : area.coordinates

  return new modules.Polygon({
    rings: rings as unknown as number[][][],
    spatialReference: modules.SpatialReference.WGS84
  })
}

function countVertices (polygon: __esri.Polygon): number {
  return (polygon?.rings ?? []).reduce((total, ring) => total + (ring?.length ?? 0), 0)
}

/**
 * Bring an outline under the vertex budget.
 *
 * The deviation starts at about a metre and doubles until the outline fits, so
 * a shape that is already small enough comes back untouched and one that is not
 * loses only as much detail as it has to. Past a certain deviation the shape
 * collapses to nothing; the last one that survived is then the closest fit
 * available.
 */
function fitVertexBudget (
  polygon: __esri.Polygon,
  modules: Modules
): { polygon: __esri.Polygon, generalized: boolean } {
  if (countVertices(polygon) <= MAX_VERTICES) return { polygon, generalized: false }

  // Degrees: the geometry is in WGS84 and generalize measures deviation in the
  // geometry's own units. 1e-5 degrees is roughly a metre.
  let deviation = 1e-5
  let best: __esri.Polygon = null

  for (let attempt = 0; attempt < 24; attempt++) {
    const simpler = modules.geometryEngine.generalize(polygon, deviation, true) as __esri.Polygon
    if (!simpler?.rings?.length) break
    best = simpler
    if (countVertices(simpler) <= MAX_VERTICES) return { polygon: simpler, generalized: true }
    deviation *= 2
  }

  // Nothing left to try: send what we have. The search is slower, not wrong.
  return best ? { polygon: best, generalized: true } : { polygon, generalized: false }
}

/**
 * What is worth saying about an adopted area, or null when nothing is.
 *
 * The bounding box note is the one that costs money: tiles are culled against
 * the box, so a long thin feature fetches imagery well outside its outline even
 * though the mask hides it.
 */
function describeArea (
  generalized: boolean,
  sqKm: number,
  extent: __esri.Extent,
  modules: Modules
): string | null {
  const notes: string[] = []

  if (generalized) {
    notes.push(`The outline was simplified to ${MAX_VERTICES.toLocaleString()} points before searching.`)
  }

  const boxSqKm = Math.abs(modules.geometryEngine.geodesicArea(
    modules.Polygon.fromExtent(extent), 'square-kilometers'
  ))
  if (sqKm > 0 && boxSqKm / sqKm >= BBOX_WARN_RATIO) {
    notes.push(
      `Tiles are fetched for the whole bounding box, about ${Math.round(boxSqKm / sqKm)} times this ` +
      'area. The imagery is clipped to the outline, but the extra tiles still count against your quota.'
    )
  }

  return notes.length > 0 ? notes.join(' ') : null
}
