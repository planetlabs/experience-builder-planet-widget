import { React } from 'jimu-core'
import { Alert, Button, Checkbox, Loading, Radio, Tab, Tabs, TextInput } from 'jimu-ui'
import { TrashOutlined } from 'jimu-icons/outlined/editor/trash'
import { ArrowUpOutlined } from 'jimu-icons/outlined/directional/arrow-up'
import { ArrowDownOutlined } from 'jimu-icons/outlined/directional/arrow-down'
import { listMosaics, listSeries, sortByAcquiredDesc, type PlanetEndpoints } from '../planet/api'
import { supportsIndices } from '../planet/renderers'
import { formatMosaicLabel } from '../planet/format'
import { type PlanetMosaic, type PlanetSeries } from '../planet/types'
import { type PlanetItem } from '../config'

/**
 * How many individual mosaics a single search will walk before stopping.
 * An account can hold tens of thousands, so the list is search-driven and the
 * cap is reported to the creator rather than silently applied.
 */
const MOSAIC_LIMIT = 250
const SEARCH_DEBOUNCE_MS = 400

interface Props {
  endpoints: PlanetEndpoints
  /** False when neither an API key nor a proxy is set, so listing cannot work. */
  configured: boolean
  items: PlanetItem[]
  onChange: (items: PlanetItem[]) => void
}

const listStyle: React.CSSProperties = {
  maxHeight: 260,
  overflowY: 'auto',
  border: '1px solid var(--sys-color-divider-secondary, #4a4a4a)',
  borderRadius: 2
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '4px 8px'
}

export default function MosaicPicker (props: Props): React.ReactElement {
  const { endpoints, configured, items, onChange } = props
  const [kind, setKind] = React.useState<'series' | 'mosaic'>('series')
  const [search, setSearch] = React.useState('')
  const [term, setTerm] = React.useState('')
  const [series, setSeries] = React.useState<PlanetSeries[]>([])
  const [mosaics, setMosaics] = React.useState<PlanetMosaic[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>(null)

  // Only the primitive parts of `endpoints` go in dependency lists: the object
  // is rebuilt on every render of the parent.
  const { apiOrigin, apiKey } = endpoints

  React.useEffect(() => {
    const handle = setTimeout(() => { setTerm(search.trim()) }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(handle) }
  }, [search])

  React.useEffect(() => {
    if (!configured) {
      setSeries([])
      setMosaics([])
      setError(null)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    const request = kind === 'series'
      ? listSeries(endpoints, { nameContains: term || undefined, signal: controller.signal })
      : listMosaics(endpoints, { nameContains: term || undefined, limit: MOSAIC_LIMIT, signal: controller.signal })

    request.then((result) => {
      if (controller.signal.aborted) return
      setTruncated(result.truncated)
      if (kind === 'series') {
        setSeries(result.items as PlanetSeries[])
      } else {
        setMosaics(sortByAcquiredDesc(result.items as PlanetMosaic[]))
      }
      setLoading(false)
    }).catch((err) => {
      if (controller.signal.aborted || err?.name === 'AbortError') return
      setError(err?.message ?? String(err))
      setLoading(false)
    })

    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, term, configured, apiOrigin, apiKey])

  const selectedIds = React.useMemo(() => new Set(items.map((item) => item.id)), [items])

  const toggle = (entry: PlanetItem, checked: boolean) => {
    onChange(checked
      ? items.concat(entry)
      : items.filter((item) => item.id !== entry.id))
  }

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = items.slice()
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  /**
   * Exactly one item can open on load, so setting a default clears whatever
   * held it before. Mosaics are opaque: several turning themselves on would
   * stack and hide each other.
   */
  const setDefault = (id: string | null) => {
    onChange(items.map((item) => {
      const { defaultOn, ...rest } = item
      return item.id === id ? { ...rest, defaultOn: true } : rest
    }))
  }

  const defaultItem = items.find((item) => item.defaultOn)

  const renderRow = (id: string, label: string, sublabel: string, entry: PlanetItem) => (
    <div key={id} style={rowStyle}>
      <Checkbox
        checked={selectedIds.has(id)}
        onChange={(evt) => { toggle(entry, evt.target.checked) }}
        aria-label={label}
        style={{ marginTop: 3 }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ wordBreak: 'break-word' }}>{label}</div>
        {sublabel && (
          <div className='text-disabled' style={{ fontSize: 11, wordBreak: 'break-word' }}>{sublabel}</div>
        )}
      </div>
    </div>
  )

  const seriesList = series.map((entry) => renderRow(
    entry.id,
    entry.name,
    entry.description ?? '',
    // A series' renderer support depends on the mosaics inside it, which are
    // only listed at runtime, so it is resolved there rather than stored.
    { kind: 'series', id: entry.id, name: entry.name, supportsIndices: false }
  ))

  const mosaicList = mosaics.map((mosaic) => renderRow(
    mosaic.id,
    mosaic.name,
    formatMosaicLabel(mosaic),
    {
      kind: 'mosaic',
      id: mosaic.id,
      name: mosaic.name,
      mosaicName: mosaic.name,
      supportsIndices: supportsIndices(mosaic)
    }
  ))

  const emptyMessage = kind === 'mosaic' && !term
    ? 'Showing the most recent mosaics. Type to search by name.'
    : 'No matches.'

  const results = kind === 'series' ? seriesList : mosaicList

  return (
    <div>
      {!configured && (
        <Alert
          form='basic'
          type='info'
          withIcon
          text='Add an API key or a proxy URL above to browse your mosaics.'
        />
      )}

      <TextInput
        className='w-100 mt-2'
        placeholder={kind === 'series' ? 'Search series by name' : 'Search mosaics by name'}
        value={search}
        disabled={!configured}
        onChange={(evt) => { setSearch(evt.target.value) }}
        aria-label='Search mosaics'
      />

      <Tabs
        className='mt-2'
        type='underline'
        value={kind}
        onChange={(id: string) => { setKind(id as 'series' | 'mosaic') }}
      >
        <Tab id='series' title='Series'>
          <div style={listStyle}>{seriesList}</div>
        </Tab>
        <Tab id='mosaic' title='Single mosaics'>
          <div style={listStyle}>{mosaicList}</div>
        </Tab>
      </Tabs>

      {loading && <Loading width={24} height={24} />}

      {error && (
        <Alert className='mt-2' form='basic' type='error' withIcon text={error} />
      )}

      {!loading && !error && configured && results.length === 0 && (
        <div className='text-disabled mt-2' style={{ fontSize: 12 }}>{emptyMessage}</div>
      )}

      {truncated && !loading && (
        <Alert
          className='mt-2'
          form='basic'
          type='warning'
          withIcon
          text={`Showing the first ${results.length} results only. Narrow the search to see the rest.`}
        />
      )}

      <div className='mt-3'>
        <div style={{ fontWeight: 500 }}>Selected ({items.length})</div>
        {items.length === 0 && (
          <div className='text-disabled' style={{ fontSize: 12 }}>
            Nothing selected yet. App users will see an empty widget.
          </div>
        )}
        {items.length > 0 && (
          <div className='text-disabled' style={{ fontSize: 11 }}>
            Pick one to switch on when the app loads, showing its most recent imagery.
          </div>
        )}
        {items.map((item, index) => (
          <div key={item.id} style={{ ...rowStyle, alignItems: 'center' }}>
            <Radio
              checked={Boolean(item.defaultOn)}
              onChange={() => { setDefault(item.id) }}
              title='Show when the app loads'
              aria-label={`Show ${item.name} when the app loads`}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ wordBreak: 'break-word' }}>{item.name}</div>
              <div className='text-disabled' style={{ fontSize: 11 }}>
                {item.kind === 'series' ? 'Series' : 'Single mosaic'}
              </div>
            </div>
            <Button
              size='sm'
              type='tertiary'
              icon
              title='Move up'
              aria-label={`Move ${item.name} up`}
              disabled={index === 0}
              onClick={() => { move(index, -1) }}
            >
              <ArrowUpOutlined />
            </Button>
            <Button
              size='sm'
              type='tertiary'
              icon
              title='Move down'
              aria-label={`Move ${item.name} down`}
              disabled={index === items.length - 1}
              onClick={() => { move(index, 1) }}
            >
              <ArrowDownOutlined />
            </Button>
            <Button
              size='sm'
              type='tertiary'
              icon
              title='Remove'
              aria-label={`Remove ${item.name}`}
              onClick={() => { onChange(items.filter((other) => other.id !== item.id)) }}
            >
              <TrashOutlined />
            </Button>
          </div>
        ))}
        {defaultItem && (
          <Button
            size='sm'
            type='link'
            onClick={() => { setDefault(null) }}
          >
            Start with nothing shown
          </Button>
        )}
      </div>
    </div>
  )
}
