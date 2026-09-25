import { React, type UseDataSource } from 'jimu-core'
import { type AllWidgetSettingProps } from 'jimu-for-builder'
import { SettingSection, SettingRow, MapWidgetSelector } from 'jimu-ui/advanced/setting-components'
import { Alert, Button, Option, Select, Tooltip } from 'jimu-ui'
import { InfoOutlined } from 'jimu-icons/outlined/suggested/info'
import { resolveAuthMode, resolveEndpoints } from '../planet/api'
import { clearStoredKey, readStoredKey } from '../planet/userKey'
import { type IMConfig, type PlanetAuthMode, type PlanetMode } from '../config'
import { VISIBLE_MODES, getMode, needsPlanetConnection, type ModeDefinition } from '../modes'
import ModePlaceholder from '../modePlaceholder'
import ModeChooser from './modeChooser'
import DraftInput from './draftInput'
import PlanetKeyPrompt, { PLANET_AUTH_DOCS } from '../planetKeyPrompt'
import MosaicsSetting from './modes/mosaics'
import ScenesSetting from './modes/scenes'
import TaskingSetting from './modes/tasking'
import { type ModeSettingProps } from './modes/types'

/**
 * Where a mode plugs its settings in. Modes absent from this map fall back to
 * the placeholder, so declaring a mode never breaks the panel.
 */
const MODE_SETTINGS: { [key: string]: React.ComponentType<ModeSettingProps> } = {
  mosaics: MosaicsSetting,
  scenes: ScenesSetting,
  tasking: TaskingSetting
}

const PROXY_HELP = (
  <div style={{ maxWidth: 260 }}>
    Replaces both api.planet.com and tiles.planet.com. The proxy must forward everything
    under <code>/basemaps/v1/</code>, routing <code>/basemaps/v1/planet-tiles</code> to
    tiles.planet.com and the rest to api.planet.com.
  </div>
)

/**
 * The authentication methods, in the order they appear in the dropdown.
 *
 * Each carries the one explanation shown for it, in a bubble whose colour is
 * the whole point: embedded is the only method that puts a credential where an
 * app user can read it, so it is the only warning. The other two are choices
 * between tradeoffs, not hazards.
 */
const AUTH_CHOICES: Array<{
  value: PlanetAuthMode
  label: string
  tone: 'warning' | 'info'
  body: string
}> = [
  {
    value: 'embedded',
    label: 'Embedded API key',
    tone: 'warning',
    body: 'Saved in the app configuration, where anyone who can open the app can read it. ' +
      'Use only behind your own authentication.'
  },
  {
    value: 'proxy',
    label: 'Proxy service',
    tone: 'info',
    body: 'A server you run alongside the app holds the key and forwards requests to Planet, ' +
      'so no credential ever reaches the browser. The proxy must sit behind the same ' +
      'authentication as the app.'
  },
  {
    value: 'user',
    label: 'User provided API key',
    tone: 'info',
    body: 'Each app user supplies their own key, which stays in their browser. Nothing is saved ' +
      'in the app and no server is needed, so it can go on static hosting.'
  }
]

export default function Setting (props: AllWidgetSettingProps<IMConfig>): React.ReactElement {
  const { config, id, useDataSources, useMapWidgetIds, onSettingChange } = props

  const apiKey = config?.apiKey ?? ''
  const proxyBaseUrl = config?.proxyBaseUrl ?? ''
  const authMode = resolveAuthMode({ authMode: config?.authMode, apiKey, proxyBaseUrl })

  // In `user` mode the creator still has to browse mosaics to choose which
  // ones to expose, and that needs a key. It is theirs, held in this browser
  // exactly as an app user's would be, and never written to the config - which
  // is the whole point of the mode.
  const [creatorKey, setCreatorKey] = React.useState(() => readStoredKey())

  const endpoints = React.useMemo(
    () => resolveEndpoints({ authMode: config?.authMode, apiKey, proxyBaseUrl }, creatorKey),
    [config?.authMode, apiKey, proxyBaseUrl, creatorKey]
  )

  const update = (next: IMConfig) => { onSettingChange({ id, config: next }) }

  /**
   * Each mode clears the settings the other two own.
   *
   * Dropping the key matters most: a credential left in the app JSON that the
   * panel no longer shows is precisely the failure the other two modes exist to
   * avoid. Dropping the proxy URL matters for the same reason in reverse -
   * `resolveEndpoints` still honours it, so a leftover value would quietly
   * redirect every call to a host the panel gives no way to see.
   */
  const selectAuthMode = (next: PlanetAuthMode): void => {
    const withMode = config.set('authMode', next)
    update(withMode
      .set('apiKey', next === 'embedded' ? apiKey : '')
      .set('proxyBaseUrl', next === 'proxy' ? proxyBaseUrl : ''))
  }

  const selectedAuth = AUTH_CHOICES.find((choice) => choice.value === authMode)

  const definition = config?.mode ? getMode(config.mode) : undefined

  // A hidden mode still has to appear in its own dropdown, otherwise an
  // instance already using one would show a blank selection and silently
  // change mode on the next edit.
  const modeOptions: ModeDefinition[] = React.useMemo(
    () => (definition && definition.hidden ? VISIBLE_MODES.concat(definition) : VISIBLE_MODES),
    [definition]
  )

  // Nothing else is meaningful until the creator has said what this widget is
  // for, so the panel is the chooser and nothing more.
  if (!definition) {
    return (
      <div className='widget-setting-planet-imagery'>
        <ModeChooser onSelect={(mode: PlanetMode) => { update(config.set('mode', mode)) }} />
      </div>
    )
  }

  const ModeSetting = MODE_SETTINGS[definition.id]

  return (
    <div className='widget-setting-planet-imagery'>
      <SettingSection title='Widget mode'>
        <SettingRow>
          <Select
            value={definition.id}
            onChange={(evt) => { update(config.set('mode', evt.target.value as PlanetMode)) }}
            aria-label='Widget mode'
          >
            {modeOptions.map((mode) => (
              <Option key={mode.id} value={mode.id}>
                {mode.label}{!mode.implemented && ' (coming soon)'}
              </Option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow>
          <div className='text-disabled' style={{ fontSize: 12 }}>{definition.description}</div>
        </SettingRow>
      </SettingSection>

      <SettingSection title='Map'>
        <SettingRow>
          <MapWidgetSelector
            onSelect={(ids: string[]) => { onSettingChange({ id, useMapWidgetIds: ids }) }}
            useMapWidgetIds={useMapWidgetIds}
          />
        </SettingRow>
      </SettingSection>

      {needsPlanetConnection(definition, config) && (
        <SettingSection title='Authentication method'>
          {/* A dropdown rather than three radios with three paragraphs under
              them: only the chosen method's settings are worth the vertical
              space, and this panel is already long. */}
          <SettingRow>
            <Select
              value={authMode}
              onChange={(evt) => { selectAuthMode(evt.target.value as PlanetAuthMode) }}
              aria-label='Authentication method'
            >
              {AUTH_CHOICES.map((choice) => (
                <Option key={choice.value} value={choice.value}>{choice.label}</Option>
              ))}
            </Select>
          </SettingRow>

          {/* One bubble per method, carrying the only explanation the panel
              offers. `Alert` renders children in place of `text`, which is how
              the link gets inside the bubble rather than orphaned under it. */}
          {selectedAuth && (
            <SettingRow>
              <Alert form='basic' type={selectedAuth.tone} withIcon>
                <div style={{ fontSize: 12 }}>
                  {selectedAuth.body}{' '}
                  <a href={PLANET_AUTH_DOCS} target='_blank' rel='noopener noreferrer'>
                    Learn about Planet Authentication
                  </a>
                </div>
              </Alert>
            </SettingRow>
          )}

          {authMode === 'embedded' && (
            <SettingRow label='API key' flow='wrap'>
              <DraftInput
                type='password'
                value={apiKey}
                placeholder='PLAK...'
                onCommit={(next) => { update(config.set('apiKey', next)) }}
                aria-label='Planet API key'
              />
            </SettingRow>
          )}

          {authMode === 'user' && (
            <SettingRow flow='wrap'>
              {creatorKey
                ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8 }}>
                    <span className='text-disabled' style={{ fontSize: 12 }}>
                      Using your key from this browser. It is not saved in the app.
                    </span>
                    <Button
                      type='link'
                      size='sm'
                      onClick={() => { clearStoredKey(); setCreatorKey('') }}
                    >
                      Change
                    </Button>
                  </div>
                  )
                : <PlanetKeyPrompt audience='creator' onConnected={setCreatorKey} />}
            </SettingRow>
          )}

          {/* The proxy's own setting, so it belongs to that method alone. The
              other two talk to Planet directly. */}
          {authMode === 'proxy' && (
            <SettingRow
              flow='wrap'
              label={
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>Proxy base URL</span>
                  <Tooltip title={PROXY_HELP} placement='bottom' interactive showArrow>
                    <span
                      tabIndex={0}
                      role='button'
                      aria-label='What the proxy must forward'
                      style={{ display: 'inline-flex', cursor: 'help' }}
                    >
                      <InfoOutlined size='s' />
                    </span>
                  </Tooltip>
                </div>
              }
            >
              <DraftInput
                value={proxyBaseUrl}
                placeholder='https://proxy.example.com'
                onCommit={(next) => { update(config.set('proxyBaseUrl', next)) }}
                aria-label='Proxy base URL'
              />
            </SettingRow>
          )}

          {authMode === 'proxy' && proxyBaseUrl.trim() !== '' &&
            !/^https:\/\//i.test(proxyBaseUrl.trim()) && (
            <SettingRow>
              <Alert
                form='basic'
                type='warning'
                withIcon
                text={'Use an absolute https:// address. Anything else sends every imagery ' +
                  'request, and the session that authorises it, in the clear.'}
              />
            </SettingRow>
          )}
        </SettingSection>
      )}

      {ModeSetting
        ? (
          <ModeSetting
            config={config}
            endpoints={endpoints}
            onConfigChange={update}
            widgetId={id}
            useDataSources={useDataSources}
            onUseDataSourcesChange={(next: UseDataSource[]) => {
              onSettingChange({ id, useDataSources: next })
            }}
          />
          )
        : (
          <SettingSection title={definition.label}>
            <SettingRow><ModePlaceholder mode={definition} /></SettingRow>
          </SettingSection>
          )}
    </div>
  )
}
