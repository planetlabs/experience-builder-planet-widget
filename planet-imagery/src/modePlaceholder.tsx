import { React } from 'jimu-core'
import { Alert } from 'jimu-ui'
import { type ModeDefinition } from './modes'

interface Props {
  mode: ModeDefinition
  /** Overrides the default "not built yet" wording. */
  text?: string
}

/** Stands in for a mode that has been declared but not implemented. */
export default function ModePlaceholder (props: Props): React.ReactElement {
  const { mode, text } = props
  return (
    <Alert
      form='basic'
      type='info'
      withIcon
      text={text ?? `${mode.label} is not built yet. ${mode.description}`}
    />
  )
}
