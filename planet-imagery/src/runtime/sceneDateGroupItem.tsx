import { React } from 'jimu-core'
import { Button, Checkbox, Switch } from 'jimu-ui'
import { ArrowDownOutlined } from 'jimu-icons/outlined/directional/arrow-down'
import { ArrowRightOutlined } from 'jimu-icons/outlined/directional/arrow-right'
import { FeatureLayerZoomToOutlined } from 'jimu-icons/outlined/gis/feature-layer-zoom-to'
import {
  acquiredTimeLabel, cloudPercent, polygonBbox, unionBbox, type SceneDateGroup
} from '../planet/scenes'
import { type PlanetScene } from '../planet/types'

interface Props {
  group: SceneDateGroup
  /** Ids from this group that are on the map, in no particular order. */
  selectedIds: string[]
  /**
   * Replace this day's selection. An empty array removes the day's layer; the
   * parent turns the whole selection into one tile layer per day.
   */
  onSelectionChange: (date: string, sceneIds: string[]) => void
  onZoom: (bbox: [number, number, number, number]) => void
  /** Draws a scene's footprint while the row is hovered or focused. */
  onPreview: (scene: PlanetScene | null) => void
}

export default function SceneDateGroupItem (props: Props): React.ReactElement {
  const { group, selectedIds, onSelectionChange, onZoom, onPreview } = props
  const [expanded, setExpanded] = React.useState(false)

  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds])
  const allSelected = selected.size > 0 && selected.size === group.scenes.length
  const someSelected = selected.size > 0 && !allSelected

  // The switch is the coarse control: a whole day on the map, or none of it.
  // The checkboxes underneath refine which strips make up that day's layer.
  const toggleDay = (on: boolean) => {
    onSelectionChange(group.date, on ? group.scenes.map((scene) => scene.id) : [])
  }

  const toggleScene = (sceneId: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(sceneId)
    else next.delete(sceneId)
    // Preserve the group's own order so the tile URL is stable across toggles
    // and the layer is not rebuilt for a reordering that changes nothing.
    onSelectionChange(group.date, group.scenes.map((s) => s.id).filter((id) => next.has(id)))
  }

  const zoomToDay = () => {
    const boxes = group.scenes
      .map((scene) => polygonBbox(scene.geometry))
      .filter((box): box is [number, number, number, number] => box !== null)
    const box = unionBbox(boxes)
    if (box) onZoom(box)
  }

  return (
    <div style={{ borderBottom: '1px solid var(--sys-color-divider-secondary, #4a4a4a)', padding: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Switch
          checked={selected.size > 0}
          onChange={(_evt, checked) => { toggleDay(checked) }}
          aria-label={`Add ${group.date} to the map`}
        />
        <button
          type='button'
          onClick={() => { setExpanded((current) => !current) }}
          aria-expanded={expanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'inherit',
            cursor: 'pointer',
            textAlign: 'left'
          }}
        >
          {expanded ? <ArrowDownOutlined size='s' /> : <ArrowRightOutlined size='s' />}
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{group.date}</span>
          <span className='text-disabled' style={{ fontSize: 11 }}>
            {someSelected
              ? `${selected.size} of ${group.scenes.length}`
              : `${group.scenes.length} ${group.scenes.length === 1 ? 'scene' : 'scenes'}`}
          </span>
        </button>
        <Button
          size='sm'
          type='tertiary'
          icon
          title='Zoom to this day'
          aria-label={`Zoom to imagery from ${group.date}`}
          onClick={zoomToDay}
        >
          <FeatureLayerZoomToOutlined size='m' />
        </Button>
      </div>

      {expanded && (
        <div style={{ paddingLeft: 22 }}>
          {group.scenes.map((scene) => (
            <SceneRow
              key={scene.id}
              scene={scene}
              checked={selected.has(scene.id)}
              onToggle={(on) => { toggleScene(scene.id, on) }}
              onZoom={onZoom}
              onPreview={onPreview}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface RowProps {
  scene: PlanetScene
  checked: boolean
  onToggle: (on: boolean) => void
  onZoom: (bbox: [number, number, number, number]) => void
  onPreview: (scene: PlanetScene | null) => void
}

function SceneRow (props: RowProps): React.ReactElement {
  const { scene, checked, onToggle, onZoom, onPreview } = props
  const cloud = cloudPercent(scene)
  const bbox = polygonBbox(scene.geometry)

  // Hovering outlines the strip on the map. Without thumbnails this is the
  // only way to tell which of a day's scenes actually covers the area.
  const preview = () => { onPreview(scene) }
  const clearPreview = () => { onPreview(null) }

  return (
    <div
      onMouseEnter={preview}
      onMouseLeave={clearPreview}
      onFocus={preview}
      onBlur={clearPreview}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}
    >
      <Checkbox
        checked={checked}
        onChange={(_evt, next) => { onToggle(next) }}
        aria-label={`Include scene ${scene.id}`}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {acquiredTimeLabel(scene)}
          {cloud !== null && <span className='text-disabled ml-2'>{cloud}% cloud</span>}
        </div>
        <div className='text-disabled' style={{ fontSize: 10, wordBreak: 'break-all' }}>{scene.id}</div>
      </div>
      <Button
        size='sm'
        type='tertiary'
        icon
        title='Zoom to this scene'
        aria-label={`Zoom to scene ${scene.id}`}
        disabled={!bbox}
        onClick={() => { if (bbox) onZoom(bbox) }}
      >
        <FeatureLayerZoomToOutlined size='m' />
      </Button>
    </div>
  )
}
