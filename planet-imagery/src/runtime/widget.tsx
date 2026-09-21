import { React, type AllWidgetProps } from 'jimu-core'
import { JimuMapViewComponent, type JimuMapView } from 'jimu-arcgis'
import { Alert, Button } from 'jimu-ui'
import { isConfigured, resolveAuthMode, resolveEndpoints } from '../planet/api'
import { clearStoredKey, readStoredKey } from '../planet/userKey'
import { type IMConfig } from '../config'
import { getMode, needsPlanetConnection } from '../modes'
import ModePlaceholder from '../modePlaceholder'
import PlanetKeyPrompt from '../planetKeyPrompt'
import MosaicsRuntime from './modes/mosaics'
import ScenesRuntime from './modes/scenes'
import TaskingRuntime from './modes/tasking'
import { type ModeRuntimeProps } from './modes/types'
import { SEARCH_AREA_STATE_KEY, type FeatureSearchArea } from '../data-actions/useAsSearchArea'
import { TASKED_IMAGERY_STATE_KEY, type TaskedCapture } from '../data-actions/loadTaskedImagery'

/**
 * Where a mode plugs its runtime in. Modes absent from this map fall back to
 * the placeholder, so declaring a mode never breaks the widget.
 */
const MODE_RUNTIMES: { [key: string]: React.ComponentType<ModeRuntimeProps> } = {
  mosaics: MosaicsRuntime,
  scenes: ScenesRuntime,
  tasking: TaskingRuntime
}

/**
 * Shell shared by every mode.
 *
 * It owns the binding to the map widget and the shared Planet connection, then
 * hands the active view and resolved endpoints to whichever mode is configured.
 */
export default function Widget (props: AllWidgetProps<IMConfig>): React.ReactElement {
  const { config, useDataSources, useMapWidgetIds, mutableStateProps } = props

  // Where the "Search Planet imagery here" data action leaves its geometry.
  // It runs outside this tree - from a feature popup - so the framework's
  // mutable store is the only channel it has back into the widget.
  const featureArea = mutableStateProps?.[SEARCH_AREA_STATE_KEY] as FeatureSearchArea
  // Likewise for "Load tasked imagery here", which hands over one capture.
  const taskedCapture = mutableStateProps?.[TASKED_IMAGERY_STATE_KEY] as TaskedCapture
  const [jimuMapView, setJimuMapView] = React.useState<JimuMapView>(null)

  const authMode = resolveAuthMode({
    authMode: config?.authMode,
    apiKey: config?.apiKey,
    proxyBaseUrl: config?.proxyBaseUrl
  })

  // Read once on mount rather than on every render: storage access can throw,
  // and the key only changes through the controls below, which set this state.
  const [userKey, setUserKey] = React.useState(
    () => authMode === 'user' ? readStoredKey() : ''
  )

  const endpoints = React.useMemo(
    () => resolveEndpoints(
      { authMode: config?.authMode, apiKey: config?.apiKey, proxyBaseUrl: config?.proxyBaseUrl },
      userKey
    ),
    [config?.authMode, config?.apiKey, config?.proxyBaseUrl, userKey]
  )

  const definition = config?.mode ? getMode(config.mode) : undefined

  if (useMapWidgetIds?.length !== 1) {
    return <>Configure the widget by selecting a map first</>
  }

  if (!definition) {
    return (
      <Alert
        form='basic'
        type='warning'
        withIcon
        text='Choose what this widget does in its settings.'
      />
    )
  }

  const ModeRuntime = MODE_RUNTIMES[definition.id]
  // Asked of the configuration, not the mode: tasking needs a credential only
  // once the archive beta is turned on.
  const usesConnection = needsPlanetConnection(definition, config)

  // The app user has to supply a key before anything can load. Distinct from
  // `needsConnection`: this is a state the user can resolve themselves, not a
  // misconfiguration they have to take to whoever built the app.
  const needsUserKey = usesConnection && authMode === 'user' && !userKey
  const needsConnection = usesConnection && authMode !== 'user' && !isConfigured(endpoints)

  const forgetKey = (): void => {
    clearStoredKey()
    setUserKey('')
  }

  return (
    <div
      className='widget-planet-imagery jimu-widget'
      style={{
        width: '100%',
        height: '100%',
        // A column rather than a block, so a mode can hand its own scrolling
        // region whatever height is left over instead of guessing at a fixed
        // pixel maximum that is wrong in every panel but one.
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: 8
      }}
    >
      <JimuMapViewComponent
        useMapWidgetId={useMapWidgetIds[0]}
        onActiveViewChange={setJimuMapView}
      />

      {needsConnection && (
        <Alert
          form='basic'
          type='warning'
          withIcon
          text='The widget needs to be configured first.'
        />
      )}

      {needsUserKey && <PlanetKeyPrompt audience='user' onConnected={setUserKey} />}

      {!needsConnection && !needsUserKey && (
        // The scroll lives here rather than on the root: a mode that wants to
        // manage its own height gets a container with a definite one, and a
        // mode that does not just overflows this and scrolls as before.
        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'auto'
          }}
        >
          {ModeRuntime
            ? (
              <ModeRuntime
                config={config}
                endpoints={endpoints}
                jimuMapView={jimuMapView}
                useDataSources={useDataSources}
                featureArea={featureArea}
                taskedCapture={taskedCapture}
              />
              )
            : <ModePlaceholder mode={definition} />}
        </div>
      )}

      {/* Both an escape hatch from a wrong key and the way to sign out of a
          shared machine, so it stays visible rather than living in a menu. */}
      {usesConnection && authMode === 'user' && userKey && (
        <div style={{ flex: '0 0 auto', paddingTop: 4, textAlign: 'right' }}>
          <Button type='link' size='sm' onClick={forgetKey}>Use a different key</Button>
        </div>
      )}
    </div>
  )
}
