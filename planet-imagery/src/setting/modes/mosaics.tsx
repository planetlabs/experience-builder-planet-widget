import { React, Immutable, type ImmutableArray } from 'jimu-core'
import { SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { isConfigured } from '../../planet/api'
import { type PlanetItem } from '../../config'
import MosaicPicker from '../mosaicPicker'
import { type ModeSettingProps } from './types'

export default function MosaicsSetting (props: ModeSettingProps): React.ReactElement {
  const { config, endpoints, onConfigChange } = props

  const items = React.useMemo<PlanetItem[]>(() => {
    const configured = config?.mosaics?.items as ImmutableArray<PlanetItem>
    return configured ? configured.asMutable({ deep: true }) : []
  }, [config?.mosaics?.items])

  const onItemsChange = (next: PlanetItem[]) => {
    onConfigChange(config.set('mosaics', Immutable({ items: next })))
  }

  return (
    <SettingSection title='Planet mosaics'>
      <SettingRow>
        <MosaicPicker
          endpoints={endpoints}
          configured={isConfigured(endpoints)}
          items={items}
          onChange={onItemsChange}
        />
      </SettingRow>
    </SettingSection>
  )
}
