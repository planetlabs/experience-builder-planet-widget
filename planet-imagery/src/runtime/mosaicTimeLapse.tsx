import { React } from 'jimu-core'
import { Alert, Button, Checkbox, Label, Option, Progress, Select, Slider } from 'jimu-ui'
import { ArrowLeftOutlined } from 'jimu-icons/outlined/directional/arrow-left'
import { ArrowRightOutlined } from 'jimu-icons/outlined/directional/arrow-right'
import { PlayOutlined } from 'jimu-icons/outlined/editor/play'
import { PauseOutlined } from 'jimu-icons/outlined/editor/pause'
import { formatMosaicLabel } from '../planet/format'
import { type PlanetMosaic } from '../planet/types'

/**
 * Animating a range of one mosaic series.
 *
 * Split out of `MosaicLayerItem` because it is the one tool here with a life of
 * its own: a range, an arming step, a preparation with progress, and a playback
 * loop, over eight pieces of state and eight effects. Left in the host those
 * sat alongside the timestep fetch and the compare pair, sharing a scope where
 * the ordering between effects was implicit - which is the shape every bug this
 * feature has had took.
 *
 * The component owns none of the map. It asks the mode to prepare frames, to
 * show one, and to take them off again, which is the same contract the host had
 * with the mode before.
 */

/** One frame of a time lapse, in the order it plays. */
export interface TimeLapseFrame {
  mosaicName: string
  title: string
}

/**
 * How many dates one time lapse will animate.
 *
 * Every frame is a live tile layer held on the map at once, so this bounds two
 * things at the same time: what the browser is asked to keep drawing, and how
 * many mosaic tiles a single click can spend. Twelve is a year of monthly
 * imagery - long enough to read as a sequence, and measurably easier on the
 * compositor than the twenty-four it started at.
 */
const MAX_LAPSE_FRAMES = 12

/**
 * How many dates a time lapse starts with.
 *
 * Deliberately far below the cap. Every date in the range fetches imagery for
 * the current view, so the opening range is a bill the user has not agreed to
 * yet - and half a year is a common thing to want, where two years is not.
 */
const DEFAULT_LAPSE_FRAMES = 6

const LAPSE_SPEEDS = [
  { value: '1000', label: 'Slow' },
  { value: '500', label: 'Medium' },
  { value: '250', label: 'Fast' }
]

interface Props {
  /** True while this item owns the mode's one time lapse. */
  active: boolean
  /** The series timesteps, newest first. */
  mosaics: PlanetMosaic[]
  itemId: string
  /** Used only to name controls for screen readers. */
  itemName: string
  renderer: string
  mapReady: boolean
  /** Bumped when the active map view changes. */
  mapEpoch: number
  /** Bumped when the view moves under a loaded lapse, which retires the frames. */
  viewMovedAt: number
  /** Part of the armed signature: either one re-points every frame URL. */
  tilesOrigin: string
  apiKey: string
  /** The layer title for a timestep, so frames are named like the item's own layer. */
  titleFor: (mosaic: PlanetMosaic) => string
  /** Resolves once every frame is drawn and playback can be seamless. */
  onPrepare: (
    itemId: string,
    frames: TimeLapseFrame[],
    renderer: string,
    onProgress: (ready: number) => void
  ) => Promise<void>
  onShow: (index: number) => void
  onStop: () => void
  /** Leave the tool entirely, which is also what releases the map. */
  onExit: () => void
}

export default function MosaicTimeLapse (props: Props): React.ReactElement {
  const {
    active, mosaics, itemId, itemName, renderer, mapReady, mapEpoch, viewMovedAt,
    tilesOrigin, apiKey, titleFor, onPrepare, onShow, onStop, onExit
  } = props

  // `oldest` and `newest` are indices into `mosaics`, which runs newest first -
  // so the oldest end of the range is the larger of the two. `pos` is a
  // position in the frames themselves, which play in the other direction.
  const [oldest, setOldest] = React.useState(0)
  const [newest, setNewest] = React.useState(0)
  const [pos, setPos] = React.useState(0)
  /**
   * The range the user has asked to load, or '' for none.
   *
   * Loading is never automatic: it fetches every date in the range at once,
   * which is real imagery quota, so it waits for Play. Holding the range itself
   * rather than a flag means changing the range disarms it for free - there is
   * no window where the old answer is applied to the new selection.
   */
  const [armedFor, setArmedFor] = React.useState('')
  /**
   * Progress, tagged with the frame set it belongs to.
   *
   * A bare count would read as complete for the instant between narrowing the
   * range and the effect that resets it - long enough to show controls driving
   * layers that are about to be torn off the map.
   */
  const [ready, setReady] = React.useState({ signature: '', count: 0 })
  const [error, setError] = React.useState<string>(null)
  const [playing, setPlaying] = React.useState(false)
  const [frameMs, setFrameMs] = React.useState(500)
  const [loop, setLoop] = React.useState(true)

  /** The frames, oldest first, which is the order they play in. */
  const frames = React.useMemo(
    () => (active ? mosaics.slice(newest, oldest + 1).reverse() : []),
    [active, mosaics, newest, oldest]
  )

  /**
   * Everything that decides what a Play would fetch.
   *
   * Not just the dates: the renderer, the endpoints and the map view are all
   * baked into the frame URLs, so a change to any of them means the loaded
   * frames are no longer the ones selected. Arming against the whole signature
   * is what makes each of those disarm instead of silently refetching the
   * range - which is the same rule as moving the range itself, and the reason
   * the prepare effect below needs no dependencies beyond this.
   */
  const signature = frames.length > 0
    ? [mapEpoch, viewMovedAt, renderer, tilesOrigin, apiKey,
        ...frames.map((mosaic) => mosaic.name)].join('|')
    : ''
  const armed = armedFor !== '' && armedFor === signature
  const readyCount = ready.signature === signature ? ready.count : 0
  const loaded = frames.length > 0 && readyCount >= frames.length
  const current = frames[pos]

  // Opening the tool starts from the most recent dates, since that is what
  // anyone watching a time lapse of a live series is usually asking about.
  React.useEffect(() => {
    if (!active) return
    setNewest(0)
    setOldest(Math.min(mosaics.length - 1, DEFAULT_LAPSE_FRAMES - 1))
  }, [active, mosaics.length])

  // Caching every frame before the first one plays is what makes playback
  // seamless; see `prepareTimeLapse` in the mode for why it happens up front.
  const framesOnMap = React.useRef(false)

  React.useEffect(() => {
    if (!active || !mapReady || !armed) return

    setPlaying(false)
    setPos(0)
    setError(null)
    setReady({ signature, count: 0 })

    // Both ends on the same date. Nothing to animate, and the frames from the
    // previous range have to come off rather than sit there as the last thing
    // that happened to be visible.
    if (frames.length < 2) {
      framesOnMap.current = false
      onStop()
      return
    }

    let cancelled = false
    framesOnMap.current = true
    onPrepare(
      itemId,
      frames.map((mosaic) => ({ mosaicName: mosaic.name, title: titleFor(mosaic) })),
      renderer,
      (count) => { if (!cancelled) setReady({ signature, count }) }
    ).catch((err) => {
      if (!cancelled) setError(err?.message ?? String(err))
    })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mapReady, armed, signature])

  /**
   * Moving the range throws away what was loaded.
   *
   * The frames on the map are no longer the ones selected, and quietly
   * reloading would spend the whole range again on a drag of a dropdown.
   */
  React.useEffect(() => {
    if (armed || !framesOnMap.current) return
    framesOnMap.current = false
    setPlaying(false)
    setReady({ signature: '', count: 0 })
    onStop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed])

  // Play is what asked for the load, so playback starts as soon as it lands.
  React.useEffect(() => {
    if (loaded) setPlaying(true)
  }, [loaded])

  /**
   * Covers what playback does not: the first frame once caching finishes, and a
   * manual step or scrub.
   *
   * Skipped while playing, because the loop already made this swap directly at
   * the moment the frame was due. Re-running it here does no harm - assigning
   * an opacity its current value changes nothing - but it walks every frame
   * again on each advance for no reason.
   */
  React.useEffect(() => {
    if (!loaded || playing) return
    onShow(pos)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, pos, playing])

  // Playback reads the position from here rather than from the render that
  // started it, so the loop below can live across frames instead of being
  // rebuilt on each one.
  const posRef = React.useRef(0)
  React.useEffect(() => { posRef.current = pos }, [pos])

  /**
   * Playback, on an animation frame rather than a timer.
   *
   * A `setTimeout` re-armed from an effect has to make a full round trip -
   * fire, set state, render, run the effect, arm the next one - before the
   * next frame is even requested, and only then does the map repaint. The
   * round trip is not constant, so the dwell times were not either.
   *
   * Two things fix that. The loop is started once, when playback starts, and
   * is not torn down and rebuilt on every frame. And it swaps the layer itself
   * the moment the frame is due, ahead of the React state that only the slider
   * and the date label need, so what is on screen no longer waits on a render.
   *
   * The next deadline is measured from the advance that just happened, not
   * from the one that was scheduled. `due += frameMs` looks tidier and keeps
   * the average cadence exact, but it is the wrong trade here: after a late
   * frame the next deadline is already in the past, so the step after a slow
   * one runs short. That is the "one drags, the next hurries" rhythm this tool
   * was reported for twice. Do not change it back - an interval that is never
   * shorter than `frameMs` is what the eye wants, and a few milliseconds of
   * drift over a loop is invisible.
   *
   * The clock is the timestamp the browser hands the callback, not
   * `performance.now()` read inside it. They are not the same thing: the
   * argument is the start of the frame and is identical for every callback in
   * it, while `performance.now()` also counts whatever ran ahead of us in that
   * frame - which, with a stack of tile layers compositing, is not constant.
   * Reading the clock late pushes the deadline out by however late we were, and
   * the following interval then measures short against the frame grid. That is
   * the "one slow step, then a quick one" that survives an otherwise
   * non-compensating schedule.
   */
  React.useEffect(() => {
    if (!playing || !loaded) return

    const total = frames.length
    let position = posRef.current
    let due: number = null
    let raf = 0

    const tick = (now: number) => {
      if (due === null) {
        due = now + frameMs
      } else if (now >= due) {
        const next = position + 1
        if (next < total) position = next
        else if (loop) position = 0
        else {
          setPlaying(false)
          return
        }
        due = now + frameMs
        posRef.current = position
        onShow(position)
        setPos(position)
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, loaded, frames.length, frameMs, loop])

  /**
   * Tear the frames off the map when this item stops time lapsing, and forget
   * that anything was ever asked for.
   *
   * Clearing `armedFor` is what makes re-entering the tool a fresh start. The
   * component is not unmounted when it closes - it renders nothing and keeps
   * its state - so a retained arming would match the signature the reopened
   * tool computes from the same default range, and it would load and play
   * before the user had touched anything. Opening a tool must not be what
   * spends the imagery.
   *
   * Guarded on having actually been the one running it: the mode holds a
   * single set of frames for every item, so one that was never lapsing must
   * not clear the frames belonging to one that is.
   */
  const wasActive = React.useRef(false)
  React.useEffect(() => {
    if (active) {
      wasActive.current = true
      return
    }
    if (!wasActive.current) return
    wasActive.current = false
    setArmedFor('')
    setPlaying(false)
    setPos(0)
    setError(null)
    setReady({ signature: '', count: 0 })
    onStop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  React.useEffect(() => {
    return () => { if (wasActive.current) onStop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The date list, built once per series rather than once per frame.
   *
   * Playback sets `pos` several times a second, and each of those re-renders
   * this component. Without the memo both `Select`s rebuild an `Option` per
   * timestep every time - a long series is hundreds of elements reconciled per
   * second, competing for the main thread with the map's own compositing. The
   * list depends on nothing that playback changes, so it does not need to move.
   * The same elements can feed both pickers: keys are scoped to their parent.
   */
  const dateOptions = React.useMemo(
    () => mosaics.map((mosaic, index) => (
      <Option key={mosaic.id ?? index} value={String(index)}>
        {formatMosaicLabel(mosaic)}
      </Option>
    )),
    [mosaics]
  )

  /**
   * Move one end of the range, dragging the other along only as far as it has
   * to go: the ends cannot cross, and the span cannot exceed the frame cap.
   */
  const pickOldest = (index: number) => {
    setOldest(index)
    setNewest((now) => Math.min(Math.max(now, index - MAX_LAPSE_FRAMES + 1, 0), index))
  }
  const pickNewest = (index: number) => {
    setNewest(index)
    setOldest((now) => Math.max(
      Math.min(now, index + MAX_LAPSE_FRAMES - 1, mosaics.length - 1), index
    ))
  }

  if (!active) return null

  const canLoad = !armed && frames.length >= 2 && !error
  const caching = armed && frames.length >= 2 && !error && !loaded
  const readyToPlay = loaded && !error
  /** Frames are on the map, which is when navigation is locked. */
  const framesLive = caching || readyToPlay

  /**
   * One control for starting and for pausing, rather than a Play that arms the
   * range and a separate transport Play that resumes it. Same button, same
   * place, whatever the tool is doing - which is also what stops it moving.
   */
  const canStart = frames.length >= 2 && !error && !caching
  const startLabel = caching ? 'Loading…' : (playing ? 'Pause' : 'Play')
  const start = () => {
    if (!armed) setArmedFor(signature)
    else setPlaying(!playing)
  }

  return (
    <div className='mt-2'>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, flex: '0 0 32px' }}>From</span>
        <Select
          size='sm'
          value={String(oldest)}
          onChange={(evt) => { pickOldest(Number(evt.target.value)) }}
          aria-label={`Oldest date in the ${itemName} time lapse`}
          style={{ flex: 1, minWidth: 0 }}
        >
          {dateOptions}
        </Select>
      </div>

      <div className='mt-1' style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, flex: '0 0 32px' }}>To</span>
        <Select
          size='sm'
          value={String(newest)}
          onChange={(evt) => { pickNewest(Number(evt.target.value)) }}
          aria-label={`Newest date in the ${itemName} time lapse`}
          style={{ flex: 1, minWidth: 0 }}
        >
          {dateOptions}
        </Select>
      </div>

      {/*
        Both controls sit directly under the pickers, above everything that
        changes size, so neither moves as the tool goes from choosing a range to
        loading to playing. Putting them last meant they shuffled on every
        transition, and the one that matters most - the way out of a locked map
        - was the one that moved.
      */}
      <div className='mt-2' style={{ display: 'flex', gap: 4 }}>
        <Button
          size='sm'
          type='primary'
          disabled={!canStart}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={playing ? 'Pause the time lapse' : 'Play the time lapse'}
          onClick={start}
        >
          {playing ? <PauseOutlined className='mr-1' /> : <PlayOutlined className='mr-1' />}
          {startLabel}
        </Button>
        <Button
          size='sm'
          type={framesLive ? 'secondary' : 'tertiary'}
          style={{ flex: 1, minWidth: 0 }}
          title={framesLive ? 'Leave the time lapse and release the map' : undefined}
          onClick={onExit}
        >
          Exit
        </Button>
      </div>

      {/* Says out loud why one end moves when the other is set. */}
      {frames.length >= MAX_LAPSE_FRAMES && (
        <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
          A time lapse covers at most {MAX_LAPSE_FRAMES} dates, so moving one end of
          the range moves the other.
        </div>
      )}

      {frames.length < 2 && (
        <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
          Choose a range covering at least two dates.
        </div>
      )}

      {error && <Alert className='mt-2' form='basic' type='error' withIcon text={error} />}

      {canLoad && (
        <>
          {/* The count is the cost. Say it before they commit to it, not after
              the imagery has already been fetched. */}
          <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
            {frames.length} dates. Each one loads imagery for the current map view, which
            is held still while it plays.
          </div>
        </>
      )}

      {caching && (
        <div className='mt-2'>
          <Progress
            value={Math.round((readyCount / frames.length) * 100)}
            aria-label='Time lapse loading progress'
          />
          <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
            Loading {readyCount} of {frames.length} dates. The full range
            loads before playback starts.
          </div>
        </div>
      )}

      {readyToPlay && (
        <>
          <div className='mt-2' style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Button
              size='sm'
              type='tertiary'
              icon
              title='Previous date'
              aria-label='Previous date'
              disabled={pos <= 0}
              onClick={() => { setPlaying(false); setPos(pos - 1) }}
            >
              <ArrowLeftOutlined />
            </Button>
            <Button
              size='sm'
              type='tertiary'
              icon
              title='Next date'
              aria-label='Next date'
              disabled={pos >= frames.length - 1}
              onClick={() => { setPlaying(false); setPos(pos + 1) }}
            >
              <ArrowRightOutlined />
            </Button>
            <Select
              size='sm'
              value={String(frameMs)}
              onChange={(evt) => { setFrameMs(Number(evt.target.value)) }}
              aria-label='Playback speed'
              style={{ flex: 1, minWidth: 0 }}
            >
              {LAPSE_SPEEDS.map((speed) => (
                <Option key={speed.value} value={speed.value}>{speed.label}</Option>
              ))}
            </Select>
          </div>

          <Slider
            className='mt-2'
            size='sm'
            min={0}
            max={frames.length - 1}
            step={1}
            value={pos}
            aria-label='Time lapse position'
            aria-valuetext={current ? formatMosaicLabel(current) : undefined}
            onChange={(evt) => { setPlaying(false); setPos(Number(evt.target.value)) }}
          />

          <div
            className='mt-1'
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
          >
            <span style={{ fontSize: 12 }}>
              {current ? formatMosaicLabel(current) : ''}
            </span>
            <Label
              check
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 }}
            >
              <Checkbox
                checked={loop}
                onChange={(_evt, checked: boolean) => { setLoop(checked) }}
                aria-label='Loop the time lapse'
              />
              Loop
            </Label>
          </div>
        </>
      )}

    </div>
  )
}
