import { React } from 'jimu-core'
import { Alert, Button, Checkbox, Label, TextInput } from 'jimu-ui'
import { PlanetApiError } from './planet/types'
import { canRemember, storeKey, validateKey, type KeyPersistence } from './planet/userKey'

/**
 * Where the app user (or, in the settings panel, the creator) supplies a
 * Planet API key of their own.
 *
 * Shared by the runtime and the settings panel because both need a credential
 * in `user` mode and neither may write one into the configuration: the runtime
 * to load imagery, the settings panel to browse mosaics while the creator picks
 * which ones to expose.
 */

/** Planet's authentication guide, linked from here and from the settings panel. */
export const PLANET_AUTH_DOCS = 'https://docs.planet.com/develop/authentication/'

interface Props {
  /** Called with the validated key once it has been stored. */
  onConnected: (key: string) => void
  /**
   * Whether the prompt explains itself. An app user needs telling why the app
   * is asking at all; a creator has already read the same thing in the
   * authentication bubble directly above this, so repeating it there just
   * makes the panel longer.
   */
  audience: 'user' | 'creator'
}

export default function PlanetKeyPrompt (props: Props): React.ReactElement {
  const { onConnected, audience } = props

  const [draft, setDraft] = React.useState('')
  const [remember, setRemember] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [error, setError] = React.useState('')

  const rememberable = React.useMemo(canRemember, [])

  // A validation call outliving the panel would set state on an unmounted tree
  // and, in the settings panel, keep running while the creator moves on.
  const abortRef = React.useRef<AbortController>(null)
  React.useEffect(() => () => { abortRef.current?.abort() }, [])

  const connect = async (): Promise<void> => {
    const key = draft.trim()
    if (!key || checking) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setChecking(true)
    setError('')
    try {
      await validateKey(key, controller.signal)
      if (controller.signal.aborted) return
      const persistence: KeyPersistence = remember ? 'device' : 'session'
      storeKey(key, persistence)
      onConnected(key)
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof PlanetApiError
        ? err.message
        : 'Could not reach Planet to check the key. Check your network and try again.')
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {audience === 'user' && (
        <div style={{ fontSize: 12 }}>
          This app does not store a Planet API key. Paste your own to load imagery.
          It stays in this browser and is never sent anywhere but Planet.
        </div>
      )}

      <TextInput
        className='w-100'
        type='password'
        value={draft}
        placeholder='PLAK...'
        disabled={checking}
        onChange={(evt) => { setDraft(evt.target.value) }}
        // Enter is what anyone pasting into a single field will press.
        onKeyDown={(evt) => { if (evt.key === 'Enter') void connect() }}
        aria-label='Your Planet API key'
      />

      {rememberable && (
        <Label check style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 }}>
          <Checkbox
            checked={remember}
            disabled={checking}
            onChange={(_evt, checked: boolean) => { setRemember(checked) }}
            aria-label='Remember this key on this browser'
          />
          Remember on this browser
        </Label>
      )}

      <Button
        type='primary'
        disabled={!draft.trim() || checking}
        onClick={() => { void connect() }}
      >
        {checking ? 'Checking…' : 'Connect'}
      </Button>

      {error && <Alert form='basic' type='error' withIcon text={error} />}

      {audience === 'user' && (
        <a
          href={PLANET_AUTH_DOCS}
          target='_blank'
          rel='noopener noreferrer'
          style={{ fontSize: 12 }}
        >
          Where to find your API key
        </a>
      )}
    </div>
  )
}
