import { Immutable, JimuFieldType, React, AllDataSourceTypes, type IMFieldSchema } from 'jimu-core'
import { SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { DataSourceSelector, FieldSelector } from 'jimu-ui/advanced/data-source-selector'
import { Alert, Switch } from 'jimu-ui'
import { type TaskingConfig } from '../../config'
import { type ModeSettingProps } from './types'

/**
 * Only feature layers: the beta needs a footprint per row to bound its tile
 * requests, and a standalone table has none.
 */
const LAYER_TYPES = Immutable([AllDataSourceTypes.FeatureLayer])

/**
 * Both string and number, because an item id column is usually text but some
 * date columns arrive as epoch milliseconds, and the two pickers share this.
 */
const ID_FIELD_TYPES = Immutable([JimuFieldType.String, JimuFieldType.Number])
const DATE_FIELD_TYPES = Immutable([JimuFieldType.Date, JimuFieldType.String, JimuFieldType.Number])

/** An item type is a name, never a number. */
const ITEM_TYPE_FIELD_TYPES = Immutable([JimuFieldType.String])

/**
 * Tasking settings.
 *
 * The deep link has nothing to configure by design: it carries only the clicked
 * location, and the dashboard supplies every other default from the user's own
 * account. Everything below belongs to the archive beta.
 */
export default function TaskingSetting (props: ModeSettingProps): React.ReactElement {
  const { config, onConfigChange, widgetId, useDataSources, onUseDataSourcesChange } = props

  const tasking: TaskingConfig = React.useMemo(
    () => (config?.tasking ? config.tasking.asMutable({ deep: true }) : {}),
    [config?.tasking]
  )
  const archiveEnabled = Boolean(tasking.archiveEnabled)
  const hasLayer = (useDataSources?.length ?? 0) > 0

  // The whole block is written back rather than one key set in place: `setIn`
  // on a path whose parent does not exist yet throws, and it does not exist
  // until the first of these settings is touched.
  const setTasking = (key: keyof TaskingConfig, value: unknown): void => {
    onConfigChange(config.set('tasking', { ...tasking, [key]: value }))
  }

  /**
   * Turning the beta off keeps the layer and the field mapping.
   *
   * Someone switching it off to compare behaviour should not have to set it up
   * again, and nothing configured here is a credential, so there is no reason
   * to clear it the way the auth modes clear an API key.
   */
  const toggleArchive = (next: boolean): void => {
    setTasking('archiveEnabled', next)
  }

  const pickField = (key: 'itemIdField' | 'itemTypeField' | 'dateField') => (fields: IMFieldSchema[]) => {
    setTasking(key, fields?.[0]?.name ?? '')
  }

  return (
    <SettingSection title='Tasking'>
      <SettingRow flow='no-wrap' label='Stream high-res imagery (Beta)'>
        <Switch
          checked={archiveEnabled}
          onChange={(_evt, checked: boolean) => { toggleArchive(checked) }}
          aria-label='Stream high-res imagery (Beta)'
        />
      </SettingRow>

      {archiveEnabled && (
        <>
          {/* The one description the panel keeps: this choice is the access
              boundary, so what belongs on the layer is worth saying here
              rather than only in the documentation. */}
          <SettingRow flow='wrap' label='Tasking data layer'>
            <div style={{ width: '100%' }}>
              <div className='text-disabled mb-2' style={{ fontSize: 12 }}>
                Select a map layer that contains metadata for the tasks you want all users to
                view in the app.
              </div>
              <DataSourceSelector
                types={LAYER_TYPES}
                useDataSources={useDataSources}
                mustUseDataSource
                hideDataView
                widgetId={widgetId}
                onChange={onUseDataSourcesChange}
                aria-label='Tasking data layer'
              />
            </div>
          </SettingRow>

          {hasLayer
            ? (
              <>
                <SettingRow flow='wrap' label='Item ID field'>
                  <FieldSelector
                    useDataSources={useDataSources}
                    types={ID_FIELD_TYPES}
                    selectedFields={Immutable(tasking.itemIdField ? [tasking.itemIdField] : [])}
                    useDropdown
                    isMultiple={false}
                    isSearchInputHidden
                    isDataSourceDropDownHidden
                    widgetId={widgetId}
                    onChange={pickField('itemIdField')}
                    aria-label='Item ID field'
                  />
                </SettingRow>

                <SettingRow flow='wrap' label='Item type field'>
                  <FieldSelector
                    useDataSources={useDataSources}
                    types={ITEM_TYPE_FIELD_TYPES}
                    selectedFields={Immutable(tasking.itemTypeField ? [tasking.itemTypeField] : [])}
                    useDropdown
                    isMultiple={false}
                    isSearchInputHidden
                    isDataSourceDropDownHidden
                    widgetId={widgetId}
                    onChange={pickField('itemTypeField')}
                    aria-label='Item type field'
                  />
                </SettingRow>

                <SettingRow flow='wrap' label='Date field'>
                  <FieldSelector
                    useDataSources={useDataSources}
                    types={DATE_FIELD_TYPES}
                    selectedFields={Immutable(tasking.dateField ? [tasking.dateField] : [])}
                    useDropdown
                    isMultiple={false}
                    isSearchInputHidden
                    isDataSourceDropDownHidden
                    widgetId={widgetId}
                    onChange={pickField('dateField')}
                    aria-label='Date field'
                  />
                </SettingRow>

                {!tasking.itemIdField && (
                  <SettingRow>
                    <Alert
                      form='basic'
                      type='warning'
                      withIcon
                      text={'Choose the item ID field. Until you do, the action stays hidden in the map popup.'}
                    />
                  </SettingRow>
                )}

                {/*
                  Worth saying out loud, because the failure is silent and looks
                  like the action is broken: without this field a Pelican row is
                  indistinguishable from a PlanetScope one, so the action hides
                  itself on exactly those rows while still appearing on SkySat.
                */}
                {tasking.itemIdField && !tasking.itemTypeField && (
                  <SettingRow>
                    <Alert
                      form='basic'
                      type='warning'
                      withIcon
                      text={'Without an item type field the action appears on SkySat rows only. ' +
                        'A Pelican ID is shaped exactly like a PlanetScope one and cannot be told apart.'}
                    />
                  </SettingRow>
                )}
              </>
              )
            : (
              <SettingRow>
                <Alert
                  form='basic'
                  type='warning'
                  withIcon
                  text={'Choose the tasking data layer. Until you do, the action stays hidden in ' +
                    'the map popup.'}
                />
              </SettingRow>
              )}
        </>
      )}
    </SettingSection>
  )
}
