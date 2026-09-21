import { React } from 'jimu-core'
import { TextInput } from 'jimu-ui'

interface Props {
  value: string
  /** Called on blur with the trimmed value, only when it actually changed. */
  onCommit: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password'
  'aria-label': string
}

/**
 * A text field that keeps typing responsive.
 *
 * Writing to the widget config on every keystroke makes the builder redraw the
 * whole settings panel, so the value is held locally and committed on blur.
 */
export default function DraftInput (props: Props): React.ReactElement {
  const { value, onCommit, placeholder, type } = props
  const [draft, setDraft] = React.useState(value)

  React.useEffect(() => { setDraft(value) }, [value])

  return (
    <TextInput
      className='w-100'
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(evt) => { setDraft(evt.target.value) }}
      onBlur={() => {
        const trimmed = draft.trim()
        if (trimmed !== value) onCommit(trimmed)
      }}
      aria-label={props['aria-label']}
    />
  )
}
