import { React } from 'jimu-core'
import { Alert, Button, Slider, TextInput } from 'jimu-ui'
import { FeatureLayerZoomToOutlined } from 'jimu-icons/outlined/gis/feature-layer-zoom-to'
import { TrashOutlined } from 'jimu-icons/outlined/editor/trash'

export interface SceneFilters {
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string
  /** 0-100. Converted to the API's 0-1 ratio when the search is built. */
  maxCloudPercent: number
}

interface Props {
  filters: SceneFilters
  onFiltersChange: (filters: SceneFilters) => void
  /** True while the sketch tool is armed. */
  drawing: boolean
  /** Geodesic area of the search area, or null when there is none. */
  areaSqKm: number | null
  /** The feature the area came from, or null when it was drawn. */
  areaLabel: string | null
  maxAreaSqKm: number
  /** False while the map view or the sketch modules are still loading. */
  mapReady: boolean
  searching: boolean
  onDraw: () => void
  onClearArea: () => void
  onZoomToArea: () => void
  onSearch: () => void
}

export default function SceneSearchForm (props: Props): React.ReactElement {
  const {
    filters, onFiltersChange, drawing, areaSqKm, areaLabel, maxAreaSqKm,
    mapReady, searching, onDraw, onClearArea, onZoomToArea, onSearch
  } = props

  const hasArea = areaSqKm !== null
  const datesValid = filters.startDate <= filters.endDate
  const canSearch = hasArea && datesValid && !searching

  const set = (patch: Partial<SceneFilters>) => { onFiltersChange({ ...filters, ...patch }) }

  return (
    <div>
      <Button
        block
        type={drawing ? 'primary' : 'default'}
        disabled={!mapReady}
        onClick={onDraw}
      >
        {drawing
          ? 'Drag a box on the map'
          : (hasArea ? 'Redraw search area' : 'Draw search area')}
      </Button>

      {hasArea && (
        <div className='mt-1' style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div
            className='text-disabled'
            // A feature name can be long; it gives way rather than squeezing
            // the zoom and clear buttons off the end of the row.
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
            title={areaLabel ?? undefined}
          >
            {areaLabel ? `${areaLabel} - ` : ''}
            {formatArea(areaSqKm)} of {maxAreaSqKm.toLocaleString()} km²
          </div>
          <Button
            size='sm'
            type='tertiary'
            icon
            title='Zoom to search area'
            aria-label='Zoom to search area'
            onClick={onZoomToArea}
          >
            <FeatureLayerZoomToOutlined size='m' />
          </Button>
          <Button
            size='sm'
            type='tertiary'
            icon
            title='Clear search area'
            aria-label='Clear search area'
            onClick={onClearArea}
          >
            <TrashOutlined size='m' />
          </Button>
        </div>
      )}

      <div className='mt-2' style={{ display: 'flex', gap: 8 }}>
        <label style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
          From
          <TextInput
            className='w-100'
            size='sm'
            type='date'
            value={filters.startDate}
            max={filters.endDate}
            onChange={(evt) => { set({ startDate: evt.target.value }) }}
            aria-label='Earliest acquisition date'
          />
        </label>
        <label style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
          To
          <TextInput
            className='w-100'
            size='sm'
            type='date'
            value={filters.endDate}
            min={filters.startDate}
            onChange={(evt) => { set({ endDate: evt.target.value }) }}
            aria-label='Latest acquisition date'
          />
        </label>
      </div>

      <div className='mt-2'>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span>Maximum cloud cover</span>
          <span>{filters.maxCloudPercent}%</span>
        </div>
        <Slider
          className='w-100'
          value={filters.maxCloudPercent}
          min={0}
          max={100}
          step={5}
          onChange={(evt) => { set({ maxCloudPercent: Number(evt.target.value) }) }}
          aria-label='Maximum cloud cover percentage'
        />
      </div>

      {!datesValid && (
        <Alert
          className='mt-2'
          form='basic'
          type='warning'
          withIcon
          text='The start date is after the end date.'
        />
      )}

      <Button
        className='mt-2'
        block
        type='primary'
        disabled={!canSearch}
        onClick={onSearch}
      >
        {searching ? 'Searching…' : 'Search'}
      </Button>

      {!hasArea && (
        <div className='text-disabled mt-1' style={{ fontSize: 11 }}>
          Draw a search area to begin, or click a polygon on the map and choose
          &quot;Search Planet imagery here&quot; from its Actions menu.
          Searches are capped at {maxAreaSqKm.toLocaleString()} km².
        </div>
      )}
    </div>
  )
}

/** Small areas need a decimal to be meaningful; large ones do not. */
function formatArea (areaSqKm: number): string {
  const rounded = areaSqKm >= 100 ? Math.round(areaSqKm) : Math.round(areaSqKm * 10) / 10
  return rounded.toLocaleString()
}
