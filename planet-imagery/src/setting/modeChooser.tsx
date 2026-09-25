import { React } from 'jimu-core'
import { Button } from 'jimu-ui'
import { SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { VISIBLE_MODES } from '../modes'
import { type PlanetMode } from '../config'

interface Props {
  onSelect: (mode: PlanetMode) => void
}

/**
 * First step of setup: which Planet capability this widget instance exposes.
 *
 * Shown only until a mode is chosen. Afterwards the mode is changed through a
 * compact dropdown, since the descriptions are only useful once.
 */
export default function ModeChooser (props: Props): React.ReactElement {
  return (
    <SettingSection title='Widget mode'>
      <SettingRow>
        <div className='text-disabled' style={{ fontSize: 12 }}>
          Choose what this widget does. You can change it later, and settings you
          enter for one mode are kept if you switch away and back.
        </div>
      </SettingRow>
      {VISIBLE_MODES.map((mode) => (
        <SettingRow key={mode.id}>
          <Button
            block
            type='tertiary'
            onClick={() => { props.onSelect(mode.id) }}
            style={{ textAlign: 'left', height: 'auto', padding: '8px 10px', whiteSpace: 'normal' }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>
                {mode.label}{!mode.implemented && ' (coming soon)'}
              </div>
              <div className='text-disabled' style={{ fontSize: 11 }}>{mode.description}</div>
            </div>
          </Button>
        </SettingRow>
      ))}
    </SettingSection>
  )
}
