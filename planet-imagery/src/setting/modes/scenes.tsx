import { React, Immutable } from 'jimu-core'
import { SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { NumericInput } from 'jimu-ui'
import { DEFAULT_SCENES_CONFIG, MAX_CONFIGURABLE_AREA_SQ_KM, type ScenesConfig } from '../../config'
import { type ModeSettingProps } from './types'

/**
 * Only the guard rails are configured here.
 *
 * A scene search answers "what was over this spot recently", so the area, the
 * dates and the cloud ceiling all belong to the app user. What the creator
 * controls is how large a question that user is allowed to ask.
 */
export default function ScenesSetting (props: ModeSettingProps): React.ReactElement {
  const { config, onConfigChange } = props

  const scenes: ScenesConfig = React.useMemo(() => ({
    ...DEFAULT_SCENES_CONFIG,
    ...(config?.scenes ? config.scenes.asMutable({ deep: true }) : {})
  }), [config?.scenes])

  const update = (patch: Partial<ScenesConfig>) => {
    onConfigChange(config.set('scenes', Immutable({ ...scenes, ...patch })))
  }

  return (
    <SettingSection title='Daily scenes'>
      <SettingRow label='Largest search area (km²)' flow='wrap'>
        <NumericInput
          className='w-100'
          value={scenes.maxAreaSqKm}
          min={1}
          max={MAX_CONFIGURABLE_AREA_SQ_KM}
          step={100}
          precision={0}
          onAcceptValue={(value) => { update({ maxAreaSqKm: toNumber(value, DEFAULT_SCENES_CONFIG.maxAreaSqKm) }) }}
          aria-label='Largest search area in square kilometres'
        />
      </SettingRow>
      <SettingRow>
        <div className='text-disabled' style={{ fontSize: 11 }}>
          A box larger than this is rejected before the search runs. PlanetScope covers the
          world daily, so a large box returns more strips than anyone can pick through.
          Capped at {MAX_CONFIGURABLE_AREA_SQ_KM.toLocaleString()} km&#178;.
        </div>
      </SettingRow>

      <SettingRow label='Starting maximum cloud cover (%)' flow='wrap'>
        <NumericInput
          className='w-100'
          value={scenes.defaultMaxCloudPercent}
          min={0}
          max={100}
          step={5}
          precision={0}
          onAcceptValue={(value) => {
            update({ defaultMaxCloudPercent: clamp(toNumber(value, DEFAULT_SCENES_CONFIG.defaultMaxCloudPercent), 0, 100) })
          }}
          aria-label='Starting maximum cloud cover percentage'
        />
      </SettingRow>

      <SettingRow label='Starting date range (days)' flow='wrap'>
        <NumericInput
          className='w-100'
          value={scenes.defaultLookbackDays}
          min={1}
          max={3650}
          step={30}
          precision={0}
          onAcceptValue={(value) => {
            update({ defaultLookbackDays: Math.max(toNumber(value, DEFAULT_SCENES_CONFIG.defaultLookbackDays), 1) })
          }}
          aria-label='Starting date range in days'
        />
      </SettingRow>
      <SettingRow>
        <div className='text-disabled' style={{ fontSize: 11 }}>
          How far back the date range reaches when the widget opens. Searching runs one month
          at a time regardless, so a long range just means more <em>Load more</em> steps.
        </div>
      </SettingRow>
    </SettingSection>
  )
}

function toNumber (value: number | string, fallback: number): number {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  return isNaN(parsed) ? fallback : parsed
}

function clamp (value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
