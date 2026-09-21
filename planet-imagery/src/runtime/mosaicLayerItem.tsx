import { React } from 'jimu-core'
import { Alert, Button, Loading, Option, Select, Switch } from 'jimu-ui'
import { ArrowLeftOutlined } from 'jimu-icons/outlined/directional/arrow-left'
import { ArrowRightOutlined } from 'jimu-icons/outlined/directional/arrow-right'
import { PinOutlined } from 'jimu-icons/outlined/application/pin'
import { PlayOutlined } from 'jimu-icons/outlined/editor/play'
import { WidgetSwipeOutlined } from 'jimu-icons/outlined/brand/widget-swipe'
import { getMosaic, listSeriesMosaics, type PlanetEndpoints } from '../planet/api'
import { DEFAULT_RENDERER, renderersFor, supportsIndices } from '../planet/renderers'
import { formatMosaicLabel } from '../planet/format'
import { type PlanetMosaic } from '../planet/types'
import { type PlanetItem } from '../config'
import { type MosaicTool } from './modes/mosaics'
import MosaicTimeLapse, { type TimeLapseFrame } from './mosaicTimeLapse'

/**
 * An item shows one layer normally, and a second one while two of its dates
 * are being compared. The role tells the parent which of the two is meant.
 *
 * Time lapse frames are not a role: there are as many of them as there are
 * dates in the range, and the parent keeps them in their own list.
 */
export type LayerRole = 'primary' | 'compare'

interface Props {
  item: PlanetItem
  endpoints: PlanetEndpoints
  /** False until the map view and the WebTileLayer module are both available. */
  mapReady: boolean
  /** Bumped when the active map view changes, so layers are re-added to it. */
  mapEpoch: number
  /** Bumped when the view moves while a time lapse is loaded. Forwarded only. */
  viewMovedAt: number
  /** False on a scene view, which cannot host a swipe handle. */
  canCompare: boolean
  /** The tool this item is running, or null when it is running none. */
  activeTool: MosaicTool | null
  onShow: (itemId: string, role: LayerRole, mosaicName: string, renderer: string, title: string) => void
  onHide: (itemId: string, role: LayerRole) => void
  onPin: (itemId: string) => void
  onToolRequest: (itemId: string, tool: MosaicTool, on: boolean) => void
  onCompareReady: (itemId: string, ready: boolean) => void
  /** Resolves once every frame is drawn and playback can be seamless. */
  onTimeLapsePrepare: (
    itemId: string,
    frames: TimeLapseFrame[],
    renderer: string,
    onProgress: (ready: number) => void
  ) => Promise<void>
  onTimeLapseShow: (index: number) => void
  onTimeLapseStop: () => void
}

export default function MosaicLayerItem (props: Props): React.ReactElement {
  const {
    item, endpoints, mapReady, mapEpoch, viewMovedAt, canCompare, activeTool,
    onShow, onHide, onPin, onToolRequest, onCompareReady,
    onTimeLapsePrepare, onTimeLapseShow, onTimeLapseStop
  } = props
  const { apiOrigin, tilesOrigin, apiKey } = endpoints

  const [enabled, setEnabled] = React.useState(Boolean(item.defaultOn))
  const [mosaics, setMosaics] = React.useState<PlanetMosaic[]>([])
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [compareIndex, setCompareIndex] = React.useState(1)
  const [renderer, setRenderer] = React.useState(DEFAULT_RENDERER)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>(null)

  // Timesteps are fetched on first activation rather than on mount, so a
  // widget configured with many series does not fire a request per series
  // before the user has asked for anything.
  React.useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setError(null)

    const load: Promise<PlanetMosaic[]> = item.kind === 'series'
      ? listSeriesMosaics(endpoints, item.id, { signal: controller.signal }).then((result) => result.items)
      : getMosaic(endpoints, item.id, controller.signal)
        .then((mosaic) => [mosaic])
        .catch((err) => {
          if (err?.name === 'AbortError') throw err
          // Only the index renderers need the metadata record; tiles can still
          // be requested by name without it.
          return [{ id: item.id, name: item.mosaicName ?? item.name }]
        })

    load.then((list) => {
      if (cancelled) return
      setMosaics(list)
      setActiveIndex(0)
      // The date most people want to compare the latest against is the one
      // before it.
      setCompareIndex(Math.min(1, Math.max(list.length - 1, 0)))
      setLoading(false)
      if (list.length === 0) setError('No imagery is published for this series yet.')
    }).catch((err) => {
      if (cancelled || err?.name === 'AbortError') return
      setError(err?.message ?? String(err))
      setLoading(false)
    })

    return () => { cancelled = true; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, item.id, apiOrigin, apiKey])

  const active = mosaics[activeIndex]
  const activeName = active?.name
  const isSeries = item.kind === 'series'
  // Comparing an item against itself would just draw the same tiles twice.
  const compareAvailable = canCompare && isSeries && mosaics.length > 1
  const comparingNow = activeTool === 'compare' && compareAvailable && enabled
  const compare = mosaics[compareIndex]
  const compareName = comparingNow ? compare?.name : undefined

  // A time lapse needs no swipe handle, so unlike compare it works on a scene
  // view as well as a map.
  const lapseAvailable = isSeries && mosaics.length > 1
  const lapsingNow = activeTool === 'timelapse' && lapseAvailable && enabled

  // Stepping the main date onto the comparison date collapses the swipe, so
  // the comparison moves out of the way instead.
  React.useEffect(() => {
    if (compareIndex !== activeIndex) return
    setCompareIndex(activeIndex < mosaics.length - 1 ? activeIndex + 1 : Math.max(activeIndex - 1, 0))
  }, [activeIndex, compareIndex, mosaics.length])

  // Index rendering is a property of the product. A series only reveals it
  // once its mosaics are listed, so the loaded record wins over the hint
  // stored at configuration time.
  const indicesAvailable = active?.datatype
    ? supportsIndices(active)
    : (item.kind === 'mosaic' ? item.supportsIndices : false)

  React.useEffect(() => {
    if (!indicesAvailable && renderer !== DEFAULT_RENDERER) setRenderer(DEFAULT_RENDERER)
  }, [indicesAvailable, renderer])

  const titleFor = (mosaic: PlanetMosaic): string => {
    const label = mosaic ? formatMosaicLabel(mosaic) : ''
    return label ? `${item.name} (${label})` : item.name
  }

  // Recreate the layer whenever anything baked into its URL changes. Mutating
  // urlTemplate in place would leave the already-fetched tiles on screen.
  React.useEffect(() => {
    // A time lapse draws the same series across its own stack of frames, so
    // this layer would sit under all of them spending tiles on nothing.
    if (lapsingNow) {
      onHide(item.id, 'primary')
      return
    }
    if (!enabled || !mapReady || !activeName) return
    onShow(item.id, 'primary', activeName, renderer, titleFor(active))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mapReady, mapEpoch, activeName, renderer, tilesOrigin, apiKey, lapsingNow])

  React.useEffect(() => {
    if (!compareName || !mapReady) {
      onHide(item.id, 'compare')
      return
    }
    onShow(item.id, 'compare', compareName, renderer, titleFor(compare))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareName, mapReady, mapEpoch, renderer, tilesOrigin, apiKey])

  // Declared after both layer effects so the pair is already on the map by the
  // time the handle is asked for.
  React.useEffect(() => {
    onCompareReady(item.id, Boolean(compareName && activeName && mapReady))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareName, activeName, mapReady, mapEpoch, renderer])

  React.useEffect(() => {
    if (enabled) return
    onHide(item.id, 'primary')
    onHide(item.id, 'compare')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  React.useEffect(() => {
    return () => {
      onHide(item.id, 'primary')
      onHide(item.id, 'compare')
      onCompareReady(item.id, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const disable = () => {
    setEnabled(false)
    if (activeTool) onToolRequest(item.id, activeTool, false)
  }

  /**
   * Hand the layer to the map and stand down. The layer keeps the date and
   * renderer it had; the item has to be switched back on to carry on browsing,
   * which is what stops a pin from silently duplicating what is on screen.
   */
  const pin = () => {
    onPin(item.id)
    disable()
  }

  // Index 0 is the most recent mosaic, so stepping "older" moves forward.
  const step = (delta: number) => {
    setActiveIndex((current) => Math.min(Math.max(current + delta, 0), mosaics.length - 1))
  }

  const rendererOptions = renderersFor(indicesAvailable)
  return (
    <div style={{ borderBottom: '1px solid var(--sys-color-divider-secondary, #4a4a4a)', padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Switch
          checked={enabled}
          onChange={(_evt, checked) => { if (checked) setEnabled(true); else disable() }}
          aria-label={`Show ${item.name}`}
        />
        <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{item.name}</div>
        {enabled && (
          <Button
            size='sm'
            type='tertiary'
            icon
            title={lapsingNow ? 'Stop the time lapse to keep a date on the map' : 'Keep this layer on the map'}
            aria-label={`Keep ${item.name} on the map`}
            disabled={!activeName || lapsingNow}
            onClick={pin}
          >
            <PinOutlined size='m' />
          </Button>
        )}
      </div>

      {enabled && loading && <Loading width={20} height={20} />}

      {enabled && error && (
        <Alert className='mt-1' form='basic' type='error' withIcon text={error} />
      )}

      {enabled && !loading && mosaics.length > 0 && (
        <div className='mt-2' style={{ paddingLeft: 4 }}>
          {isSeries && !lapsingNow && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Button
                size='sm'
                type='tertiary'
                icon
                title='Older'
                aria-label='Older imagery'
                disabled={activeIndex >= mosaics.length - 1}
                onClick={() => { step(1) }}
              >
                <ArrowLeftOutlined />
              </Button>
              <Select
                size='sm'
                value={String(activeIndex)}
                onChange={(evt) => { setActiveIndex(Number(evt.target.value)) }}
                aria-label='Imagery date'
                style={{ flex: 1, minWidth: 0 }}
              >
                {mosaics.map((mosaic, index) => (
                  <Option key={mosaic.id ?? index} value={String(index)}>
                    {formatMosaicLabel(mosaic)}
                  </Option>
                ))}
              </Select>
              <Button
                size='sm'
                type='tertiary'
                icon
                title='Newer'
                aria-label='Newer imagery'
                disabled={activeIndex <= 0}
                onClick={() => { step(-1) }}
              >
                <ArrowRightOutlined />
              </Button>
            </div>
          )}

          {!isSeries && active && (
            <div className='text-disabled' style={{ fontSize: 11 }}>{formatMosaicLabel(active)}</div>
          )}

          <div className='mt-2' style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12 }}>Renderer</span>
            <Select
              size='sm'
              value={renderer}
              disabled={rendererOptions.length < 2}
              onChange={(evt) => { setRenderer(evt.target.value) }}
              aria-label={`Renderer for ${item.name}`}
              style={{ flex: 1, minWidth: 0 }}
            >
              {rendererOptions.map((option) => (
                <Option key={option.value} value={option.value}>{option.label}</Option>
              ))}
            </Select>
          </div>

          {!indicesAvailable && (
            <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
              Spectral indices need a surface reflectance mosaic.
            </div>
          )}

          {(compareAvailable || lapseAvailable) && (
            <div className='mt-2'>
              {/* Each tool appears only where it can work. A greyed-out button
                  naming a condition the app user cannot change - a 3D scene, a
                  series with a single date - is a dead end; the creator reads
                  about both in the documentation instead. */}
              <div style={{ display: 'flex', gap: 4 }}>
                {compareAvailable && (
                  <Button
                    size='sm'
                    type={comparingNow ? 'primary' : 'tertiary'}
                    style={{ flex: 1, minWidth: 0 }}
                    onClick={() => { onToolRequest(item.id, 'compare', !comparingNow) }}
                  >
                    <WidgetSwipeOutlined className='mr-1' />
                    Compare
                  </Button>
                )}
                {lapseAvailable && (
                  <Button
                    size='sm'
                    type={lapsingNow ? 'primary' : 'tertiary'}
                    style={{ flex: 1, minWidth: 0 }}
                    onClick={() => { onToolRequest(item.id, 'timelapse', !lapsingNow) }}
                  >
                    <PlayOutlined className='mr-1' />
                    Time lapse
                  </Button>
                )}
              </div>

              {comparingNow && (
                <>
                  <div className='mt-2' style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Left side</span>
                    <Select
                      size='sm'
                      value={String(compareIndex)}
                      onChange={(evt) => { setCompareIndex(Number(evt.target.value)) }}
                      aria-label={`Date to compare ${item.name} against`}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {mosaics
                        .map((mosaic, index) => ({ mosaic, index }))
                        .filter(({ index }) => index !== activeIndex)
                        .map(({ mosaic, index }) => (
                          <Option key={mosaic.id ?? index} value={String(index)}>
                            {formatMosaicLabel(mosaic)}
                          </Option>
                        ))}
                    </Select>
                  </div>
                  <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
                    Drag the handle on the map. The date above shows on its left, the date
                    selected for this layer on its right.
                  </div>
                </>
              )}

              <MosaicTimeLapse
                active={lapsingNow}
                mosaics={mosaics}
                itemId={item.id}
                itemName={item.name}
                renderer={renderer}
                mapReady={mapReady}
                mapEpoch={mapEpoch}
                viewMovedAt={viewMovedAt}
                tilesOrigin={tilesOrigin}
                apiKey={apiKey}
                titleFor={titleFor}
                onPrepare={onTimeLapsePrepare}
                onShow={onTimeLapseShow}
                onStop={onTimeLapseStop}
                onExit={() => { onToolRequest(item.id, 'timelapse', false) }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
