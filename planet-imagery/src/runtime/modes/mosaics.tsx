import { React, type ImmutableArray } from 'jimu-core'
import { loadArcGISJSAPIModules, type JimuMapView } from 'jimu-arcgis'
import { Alert, Button } from 'jimu-ui'
import { TrashOutlined } from 'jimu-icons/outlined/editor/trash'
import { buildTileUrlTemplate } from '../../planet/api'
import { type PlanetItem } from '../../config'
import MosaicLayerItem, { type LayerRole } from '../mosaicLayerItem'
import { type TimeLapseFrame } from '../mosaicTimeLapse'
import { type ModeRuntimeProps } from './types'

/**
 * Stop a layer view easing its opacity, so a time lapse frame appears at once.
 *
 * The default is to ease. Every 2D layer view turns on `fadeTransitionEnabled`
 * for its container and pipes `layer.opacity` into it, after which
 * `computedOpacity` - the value actually rendered - walks toward the target
 * over `mapview-transitions-duration`, 200ms out of the box. Setting an
 * opacity therefore starts an animation rather than making a change.
 *
 * For a crossfade between two frames that means both are part transparent at
 * the same time and the basemap shows through both of them. At the Fast speed
 * the 200ms ramp covers most of a 250ms step, so it reads less as a flicker
 * than as the imagery washing out on every frame.
 *
 * `container` is not part of the public API, so this is written to fail
 * quietly: if a future version of the ArcGIS API moves it, the time lapse goes
 * back to fading rather than breaking. It is also 2D-only; a scene view uses a
 * different layer view implementation and simply will not have it.
 */
function disableFadeTransition (layerView: unknown): void {
  const container = (layerView as { container?: { fadeTransitionEnabled?: boolean, endTransitions?: () => void } })?.container
  if (!container) return
  container.fadeTransitionEnabled = false
  container.endTransitions?.()
}

/**
 * Marks a layer that has been handed off to the map and no longer belongs to
 * the widget. The prefix is what lets a remounted widget find the layers a
 * previous mount pinned, instead of stranding them with no way to remove them.
 */
const PINNED_LAYER_ID_PREFIX = 'planet-pinned-'

// Module scope so the sequence keeps climbing across remounts within a page
// session, which is exactly as long as pinned layers live.
let pinSequence = 0

/**
 * The slice of the view API the navigation lock needs.
 *
 * Declared here because `__esri.MapView`, as the path mapping resolves it,
 * carries only the base `on` overloads - the pointer and keyboard events are
 * missing from that alias. A typings gap rather than an API one: these are the
 * event names Esri documents for disabling navigation.
 */
interface NavigationEvents {
  on: (
    name: string,
    modifiersOrHandler: string[] | ((event: ViewInputEvent) => void),
    handler?: (event: ViewInputEvent) => void
  ) => IHandle
}

interface ViewInputEvent {
  stopPropagation: () => void
  key?: string
}

/** The two tools an item can run. Both take over its layers, so they are exclusive. */
export type MosaicTool = 'compare' | 'timelapse'

interface State {
  modulesReady: boolean
  /** Bumped on every active view change so children re-add their layers. */
  mapEpoch: number
  /** Layers handed off to the map, listed so they can still be removed. */
  pinned: __esri.Layer[]
  /**
   * The one item running a tool, if any.
   *
   * Exclusive across items as well as within one: a second swipe handle would
   * make the map unreadable, and a second time lapse would double the tiles
   * being cached for an animation nobody is watching.
   */
  activeTool: { itemId: string, tool: MosaicTool } | null
  /**
   * Bumped when the view moves while a time lapse is loaded.
   *
   * Threaded down into the armed signature, so a move retires the frames the
   * same way changing the range does. Navigation is locked while frames are on
   * the map, but a lock built out of input events cannot stop the zoom buttons
   * or another widget calling `goTo`, so this is the backstop.
   */
  viewMovedAt: number
}

export default class MosaicsRuntime extends React.PureComponent<ModeRuntimeProps, State> {
  WebTileLayer: typeof __esri.WebTileLayer
  GroupLayer: typeof __esri.GroupLayer
  Swipe: typeof __esri.Swipe
  reactiveUtils: typeof __esri.reactiveUtils
  /** Layers the widget owns, keyed by item id and role. */
  layers = new Map<string, __esri.Layer>()
  swipe: __esri.Swipe = null
  /** Which item the live swipe handle belongs to. */
  swipeOwner: string = null

  /**
   * The frames, in one group rather than loose on the map.
   *
   * A group because the map is not ours: Experience Builder builds a layer view
   * and a data source for every operational layer, so dropping two dozen in at
   * once - and, to get the draw order right, at index 0, which renumbers every
   * layer already there - is a lot of churn to put a host through. One group
   * is one add and one remove, the children are not operational layers, and the
   * draw order inside it is ours to set. Both other modes already work this way.
   */
  timeLapseGroup: __esri.GroupLayer = null
  /** One layer per frame, in the order they play. Children of the group above. */
  timeLapseLayers: __esri.Layer[] = []
  /**
   * Invalidates an in-flight preparation.
   *
   * Changing the range while the previous one is still caching is normal, and
   * the frames it was waiting on are gone off the map by then. Bumping this
   * lets those awaits return without reporting progress for a set that no
   * longer exists.
   */
  timeLapseToken = 0
  /** Input handles that hold the view still while frames are on the map. */
  navigationLocks: IHandle[] = []
  /** Watches for a view move the locks above cannot prevent. */
  timeLapseWatch: IHandle = null

  state: State = {
    modulesReady: false,
    mapEpoch: 0,
    pinned: [],
    activeTool: null,
    viewMovedAt: 0
  }

  async componentDidMount () {
    const [WebTileLayer, GroupLayer, Swipe, reactiveUtils] = await loadArcGISJSAPIModules([
      'esri/layers/WebTileLayer',
      'esri/layers/GroupLayer',
      'esri/widgets/Swipe',
      'esri/core/reactiveUtils'
    ])
    this.WebTileLayer = WebTileLayer
    this.GroupLayer = GroupLayer
    this.Swipe = Swipe
    this.reactiveUtils = reactiveUtils
    this.setState({ modulesReady: true })
    this.adoptPinnedLayers()
  }

  componentDidUpdate (prevProps: ModeRuntimeProps) {
    if (prevProps.jimuMapView === this.props.jimuMapView) return
    // Owned layers, the swipe handle and the time lapse frames all belong to
    // the outgoing view, so they have to be taken off that one, not the view
    // that has just replaced it.
    this.clearSwipe(prevProps.jimuMapView)
    this.clearTimeLapse(prevProps.jimuMapView)
    this.removeAllLayers(prevProps.jimuMapView)
    this.setState((state) => ({ mapEpoch: state.mapEpoch + 1 }))
    // Pinned layers stay on the map they were pinned to, so the list has to be
    // rebuilt from whichever view is now showing.
    this.adoptPinnedLayers()
  }

  componentWillUnmount () {
    this.clearSwipe()
    this.clearTimeLapse()
    // Only owned layers come off. Pinned ones were handed to the map on
    // purpose and are meant to outlive the widget.
    this.removeAllLayers()
  }

  getItems (): PlanetItem[] {
    const items = this.props.config?.mosaics?.items as ImmutableArray<PlanetItem>
    return items ? items.asMutable({ deep: true }) : []
  }

  layerKey = (itemId: string, role: LayerRole) => (
    role === 'compare' ? `${itemId}::compare` : itemId
  )

  /**
   * Add or replace one of an item's layers.
   *
   * A new layer is built rather than the existing one's `urlTemplate` mutated,
   * because already-fetched tiles would otherwise stay on screen after a date
   * or renderer change. It is inserted at the outgoing layer's position first
   * so the stack order survives the swap.
   */
  showLayer = (itemId: string, role: LayerRole, mosaicName: string, renderer: string, title: string) => {
    const map = this.props.jimuMapView?.view?.map
    if (!map || !this.WebTileLayer) return

    const { endpoints } = this.props
    const key = this.layerKey(itemId, role)
    const previous = this.layers.get(key)
    const index = previous ? Math.max(map.layers.indexOf(previous), 0) : 0

    const layer = new this.WebTileLayer({
      urlTemplate: buildTileUrlTemplate(mosaicName, renderer, endpoints),
      subDomains: endpoints.subDomains.length > 0 ? endpoints.subDomains : undefined,
      title,
      copyright: 'Imagery © Planet Labs PBC'
    })

    this.layers.set(key, layer)
    map.add(layer, index)
    if (previous) map.remove(previous)

    // The swipe holds a reference to the layer it was given, so replacing one
    // of the pair leaves it pointing at a layer that is no longer on the map.
    if (this.swipeOwner === itemId) this.applySwipe(itemId)
  }

  hideLayer = (itemId: string, role: LayerRole) => {
    const key = this.layerKey(itemId, role)
    const layer = this.layers.get(key)
    if (!layer) return
    this.layers.delete(key)
    this.props.jimuMapView?.view?.map?.remove(layer)
  }

  removeAllLayers = (jimuMapView: JimuMapView = this.props.jimuMapView) => {
    const map = jimuMapView?.view?.map
    this.layers.forEach((layer) => { map?.remove(layer) })
    this.layers.clear()
  }

  /**
   * Hand an item's current layer over to the map.
   *
   * The widget stops tracking it, which is what makes the hand-off work: the
   * item switches itself off immediately afterwards, and the hide that follows
   * finds nothing of its own left to remove.
   */
  pinLayer = (itemId: string) => {
    const key = this.layerKey(itemId, 'primary')
    const layer = this.layers.get(key)
    if (!layer) return
    this.layers.delete(key)
    pinSequence += 1
    layer.id = `${PINNED_LAYER_ID_PREFIX}${pinSequence}`
    this.adoptPinnedLayers()
  }

  unpinLayer = (layer: __esri.Layer) => {
    this.props.jimuMapView?.view?.map?.remove(layer)
    this.adoptPinnedLayers()
  }

  /** The map is the record of what is pinned, so the list is read back from it. */
  adoptPinnedLayers = () => {
    const layers = this.props.jimuMapView?.view?.map?.layers
    this.setState({
      pinned: layers
        ? layers.filter((layer) => layer.id?.startsWith(PINNED_LAYER_ID_PREFIX)).toArray()
        : []
    })
  }

  /** Exclusive: starting a tool ends whichever one was already running. */
  requestTool = (itemId: string, tool: MosaicTool, on: boolean) => {
    this.setState((state) => {
      if (on) return { activeTool: { itemId, tool } }
      const active = state.activeTool
      return active?.itemId === itemId && active.tool === tool ? { activeTool: null } : null
    })
  }

  /**
   * Called by an item once both of its layers are on the map, or once either
   * of them is gone. The item owns the layers; this only owns the handle.
   */
  setCompareReady = (itemId: string, ready: boolean) => {
    if (ready) this.applySwipe(itemId)
    // An item standing down cannot tear down a handle that now belongs to
    // another one: sibling effects fire in render order, not intent order.
    else if (this.swipeOwner === itemId) this.clearSwipe()
  }

  applySwipe = (itemId: string) => {
    const view = this.props.jimuMapView?.view
    const leading = this.layers.get(this.layerKey(itemId, 'compare'))
    const trailing = this.layers.get(this.layerKey(itemId, 'primary'))
    if (!this.swipeSupported() || !this.Swipe || !leading || !trailing) return

    if (!this.swipe) {
      this.swipe = new this.Swipe({ view: view as __esri.MapView, position: 50 })
      view.ui.add(this.swipe)
    }
    this.swipeOwner = itemId
    this.swipe.leadingLayers.removeAll()
    this.swipe.trailingLayers.removeAll()
    this.swipe.leadingLayers.add(leading)
    this.swipe.trailingLayers.add(trailing)
  }

  /** The swipe widget is a 2D control; a scene view cannot host one. */
  swipeSupported = (): boolean => this.props.jimuMapView?.view?.type === '2d'

  clearSwipe = (jimuMapView: JimuMapView = this.props.jimuMapView) => {
    if (!this.swipe) return
    jimuMapView?.view?.ui?.remove(this.swipe)
    this.swipe.destroy()
    this.swipe = null
    this.swipeOwner = null
  }

  /**
   * Put every frame of a time lapse on the map and wait for all of them to draw.
   *
   * This is the whole trick behind a seamless playback. Every frame is added at
   * once and left fully transparent, because `opacity: 0` still fetches and
   * draws where `visible: false` does not. Playing then only changes an opacity
   * on a layer whose tiles are already decoded and on the GPU, which the next
   * frame renders - no request, no gap, nothing of the basemap showing through.
   *
   * The cost is paid up front instead: every frame in the range is fetched
   * before the first one plays, which is what the progress bar is counting.
   *
   * Resolves once the range is ready, and rejects if a frame cannot be drawn.
   * A preparation superseded by a newer one resolves without doing anything.
   */
  prepareTimeLapse = async (
    itemId: string,
    frames: TimeLapseFrame[],
    renderer: string,
    onProgress: (ready: number) => void
  ): Promise<void> => {
    const view = this.props.jimuMapView?.view
    if (!view || !this.WebTileLayer || frames.length === 0) return

    this.clearTimeLapse()
    const token = this.timeLapseToken
    const { endpoints } = this.props

    /**
     * Bounded to the view the frames were prepared for.
     *
     * Every frame is a live layer, so without this a single pan asks all of
     * them for a fresh set of tiles - a dozen times the cost of moving an
     * ordinary mosaic, spent without anyone asking. It also protects the
     * preparation itself: the promise that playback is seamless only holds for
     * ground that was drawn before it started. Scenes and tasking both bound
     * their layers the same way; this was the one that did not.
     */
    const prepared = view.extent?.clone()

    const layers = frames.map((frame) => new this.WebTileLayer({
      urlTemplate: buildTileUrlTemplate(frame.mosaicName, renderer, endpoints),
      subDomains: endpoints.subDomains.length > 0 ? endpoints.subDomains : undefined,
      title: frame.title,
      copyright: 'Imagery © Planet Labs PBC',
      opacity: 0,
      fullExtent: prepared ?? undefined,
      // A dozen entries for one animation would swamp the map's layer list,
      // and none of them outlives the time lapse.
      listMode: 'hide'
    }))

    // Index 0, matching where `showLayer` puts an ordinary mosaic. Appending
    // instead would stack the frames above every operational layer on the map,
    // so pressing Play would hide the customer's own layers until it stopped.
    const group = new this.GroupLayer({
      title: 'Planet time lapse',
      listMode: 'hide',
      layers
    })
    this.timeLapseGroup = group
    this.timeLapseLayers = layers
    view.map.add(group, 0)

    this.lockNavigation(view)
    this.watchForViewMove(view)

    let ready = 0
    await Promise.all(layers.map(async (layer) => {
      const layerView = await view.whenLayerView(layer)
      disableFadeTransition(layerView)
      // `updating` is the layer view's own account of whether tiles are still
      // in flight, and it is false twice: once before the first request has
      // been made, and once when they have all come back. Settling for it
      // twice a frame apart is what tells those two apart. Taking the first
      // one at face value would call a frame ready before it had fetched
      // anything, and it would flash on the opening pass.
      await this.reactiveUtils.whenOnce(() => !layerView.updating)
      await new Promise<number>((resolve) => requestAnimationFrame(resolve))
      await this.reactiveUtils.whenOnce(() => !layerView.updating)
      if (this.timeLapseToken !== token) return
      ready += 1
      onProgress(ready)
    }))
  }

  /**
   * Show one frame. Instant: the frame is already drawn, just transparent.
   *
   * The incoming frame is raised before the outgoing ones are dropped, and the
   * order is the whole point. Going the other way leaves a turn of the render
   * loop in which every frame is transparent, and the basemap paints through
   * the imagery - a pale flash, which is exactly what this tool exists to
   * avoid. Two opaque frames drawn at once costs nothing to look at, because
   * they cover the same ground and the upper one wins.
   */
  showTimeLapseFrame = (index: number) => {
    const incoming = this.timeLapseLayers[index]
    if (incoming) incoming.opacity = 1
    this.timeLapseLayers.forEach((layer, position) => {
      if (position !== index) layer.opacity = 0
    })
  }

  /**
   * Hold the view still while frames are on the map.
   *
   * There is no `view.navigation.enabled`; Esri's documented way to disable
   * navigation is to swallow the input events, which is what this does. It
   * covers gestures only - the zoom buttons and any other widget calling
   * `goTo` still move the view - so `watchForViewMove` backs it up.
   *
   * The lock is released in `clearTimeLapse`, before anything that can return
   * early, because a lock left attached is a map the user cannot move and no
   * way to find out why.
   */
  lockNavigation = (view: __esri.MapView | __esri.SceneView) => {
    this.unlockNavigation()
    const swallow = (event: ViewInputEvent) => { event.stopPropagation() }
    const keys = ['+', '-', '_', '=', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    const target = view as unknown as NavigationEvents

    this.navigationLocks = [
      target.on('mouse-wheel', swallow),
      target.on('drag', swallow),
      target.on('drag', ['Shift'], swallow),
      target.on('drag', ['Shift', 'Control'], swallow),
      target.on('double-click', swallow),
      target.on('double-click', ['Control'], swallow),
      target.on('key-down', (event) => { if (keys.includes(event.key)) event.stopPropagation() })
    ]
  }

  unlockNavigation = () => {
    this.navigationLocks.forEach((handle) => { handle.remove() })
    this.navigationLocks = []
  }

  /**
   * Retire the frames if the view moves in spite of the lock.
   *
   * Checked only once the view has settled, so an animation in progress does
   * not fire this on every frame of itself. The thresholds are deliberately
   * loose: the question is whether the prepared tiles still cover what is on
   * screen, not whether the extent is identical to the pixel.
   */
  watchForViewMove = (view: __esri.MapView | __esri.SceneView) => {
    const scale = view.scale
    const centre = view.center?.clone()

    this.timeLapseWatch = this.reactiveUtils.watch(() => view.stationary, (stationary) => {
      if (!stationary || !centre || !view.center) return
      const zoomed = Math.abs(view.scale - scale) > scale * 0.01
      const panned = Math.hypot(view.center.x - centre.x, view.center.y - centre.y) >
        (view.extent?.width ?? 0) * 0.02
      if (zoomed || panned) this.setState({ viewMovedAt: Date.now() })
    })
  }

  /** The child's stop button, which must not be handed an event as a view. */
  stopTimeLapse = () => { this.clearTimeLapse() }

  clearTimeLapse = (jimuMapView: JimuMapView = this.props.jimuMapView) => {
    this.timeLapseToken += 1
    // Before the early return: a lock left on is a map nobody can move.
    this.unlockNavigation()
    this.timeLapseWatch?.remove()
    this.timeLapseWatch = null
    if (!this.timeLapseGroup) return
    const group = this.timeLapseGroup
    this.timeLapseGroup = null
    this.timeLapseLayers = []
    // Removing the group destroys the frames with it, which is the point of
    // putting them in one.
    jimuMapView?.view?.map?.remove(group)
    group.destroy()
  }

  renderPinned () {
    const { pinned } = this.state
    if (pinned.length === 0) return null

    return (
      <div className='mt-3'>
        <div style={{ fontWeight: 500, fontSize: 12 }}>Kept on the map</div>
        {pinned.map((layer) => (
          <div key={layer.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <div className='text-disabled' style={{ flex: 1, minWidth: 0, fontSize: 12, wordBreak: 'break-word' }}>
              {layer.title || 'Planet imagery'}
            </div>
            <Button
              size='sm'
              type='tertiary'
              icon
              title='Remove from map'
              aria-label={`Remove ${layer.title || 'layer'} from the map`}
              onClick={() => { this.unpinLayer(layer) }}
            >
              <TrashOutlined />
            </Button>
          </div>
        ))}
      </div>
    )
  }

  render () {
    const items = this.getItems()
    const mapReady = this.state.modulesReady && Boolean(this.props.jimuMapView)

    if (items.length === 0) {
      return (
        <Alert
          form='basic'
          type='info'
          withIcon
          text='No mosaics have been added to this widget yet.'
        />
      )
    }

    return (
      <>
        {items.map((item) => (
          <MosaicLayerItem
            key={item.id}
            item={item}
            endpoints={this.props.endpoints}
            mapReady={mapReady}
            mapEpoch={this.state.mapEpoch}
            viewMovedAt={this.state.viewMovedAt}
            canCompare={mapReady && this.swipeSupported()}
            activeTool={
              this.state.activeTool?.itemId === item.id ? this.state.activeTool.tool : null
            }
            onShow={this.showLayer}
            onHide={this.hideLayer}
            onPin={this.pinLayer}
            onToolRequest={this.requestTool}
            onCompareReady={this.setCompareReady}
            onTimeLapsePrepare={this.prepareTimeLapse}
            onTimeLapseShow={this.showTimeLapseFrame}
            onTimeLapseStop={this.stopTimeLapse}
          />
        ))}
        {this.renderPinned()}
      </>
    )
  }
}
