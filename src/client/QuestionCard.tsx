/**
 * The floating board's inline question card (L2).
 *
 * The card answers a question whose projection state is `continued` through
 * `remote.userQuestions.answer`. A question whose foreground wait is still `open`
 * is owned by the shipped user-questions card (its claim + waterfall), so this
 * card shows it read-only and offers "open session" instead of duplicating that
 * state machine.
 *
 * Five families are rendered (see {@link QuestionKind}):
 *
 * | kind            | card                                             |
 * |-----------------|--------------------------------------------------|
 * | `continued`     | one text box                                     |
 * | `single_select` | radio group, optional "other" text               |
 * | `multi_select`  | checkbox group (at least one), optional "other"  |
 * | `confirm`       | clipped plan preview, Approve / Reject with note |
 * | `complex_open`  | read-only summary + "open the session" button    |
 *
 * Three guarantees hold for every family:
 *
 * - **Idempotent**: once submitted the whole card is locked until the host answers
 *   or fails, so a double click cannot send twice.
 * - **No cross-talk**: the draft belongs to one question signature (call id plus
 *   question ids). A different question remounts the card with a blank draft, so
 *   an old draft is never sent to a new question.
 * - **Recoverable**: a failed submit keeps the draft and offers the session as a
 *   fallback.
 *
 * All questions of one `ask_user_question` call are rendered together and
 * submitted as one batch, because the Host accepts exactly one answer per
 * question of the call.
 * @module dsh-plugin-status-board/client/QuestionCard
 */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import {
  approveLabelOf,
  classifyQuestionCall,
  declineLabelOf,
  summaryPreviewOf,
  firstParagraphOf,
} from '../shared/question.ts'
import type {
  ActiveQuestion,
  AnswerBatch,
  BoardEntry,
  QuestionAnswer,
  QuestionKind,
  SessionQuestion,
} from '../shared/types.ts'
import type { Translate } from '../shared/i18n.ts'

/** Submit one answer batch to the Host; rejects with a user-facing message. */
export type AnswerQuestion = (sessionId: string, callId: string, answer: AnswerBatch) => Promise<void>

/** Per-question draft state. */
interface Draft {
  readonly selected: readonly string[]
  readonly custom: string
}

/** Identity of one question call; a change means "a different question". */
export function callSignature(call: ActiveQuestion): string {
  return `${call.callId}:${call.questions.map(question => question.id).join(',')}`
}

/** The family of a call, deriving it when the adapter did not. */
export function kindOf(call: ActiveQuestion): QuestionKind {
  return call.kind ?? classifyQuestionCall(call)
}

/** Build the initial (blank) draft for one call. */
function initialDraft(call: ActiveQuestion): Record<string, Draft> {
  const draft: Record<string, Draft> = {}
  for (const question of call.questions) draft[question.id] = { selected: [], custom: '' }
  return draft
}

/** Read one question's draft, falling back to a blank one. */
function draftOf(draft: Record<string, Draft>, id: string): Draft {
  return draft[id] ?? { selected: [], custom: '' }
}

/** Build the answer batch from the current drafts. */
function answerBatch(call: ActiveQuestion, draft: Record<string, Draft>): AnswerBatch {
  const answers: QuestionAnswer[] = call.questions.map(question => {
    const current = draftOf(draft, question.id)
    const custom = current.custom.trim()
    // A single-select custom answer overrides the picked option; a multi-select
    // one supplements it. This mirrors the Host's documented answer shape.
    const selected = custom.length > 0 && question.multiSelect !== true ? [] : current.selected
    return {
      id: question.id,
      selected,
      ...(custom.length === 0 ? {} : { custom }),
    }
  })
  return { answers }
}

/** Whether a draft is complete enough to send for this family. */
function isComplete(kind: QuestionKind, call: ActiveQuestion, draft: Record<string, Draft>): boolean {
  if (kind === 'continued') return true
  return call.questions.every(question => {
    const current = draftOf(draft, question.id)
    return current.selected.length > 0 || current.custom.trim().length > 0
  })
}

/** Shared submit lifecycle: lock, call the host, keep the draft on failure. */
function useSubmission(
  answerQuestion: AnswerQuestion | undefined,
  sessionId: string,
  callId: string,
): {
  readonly submitting: boolean
  readonly sent: boolean
  readonly error: string | null
  readonly send: (batch: AnswerBatch) => void
} {
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A ref, not state: two clicks in the same tick both see the stale `false`.
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const send = (batch: AnswerBatch): void => {
    if (answerQuestion === undefined || inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    setSent(false)
    answerQuestion(sessionId, callId, batch)
      .then(() => {
        if (alive.current) setSent(true)
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        inFlight.current = false
        if (alive.current) setSubmitting(false)
      })
  }
  return { submitting, sent, error, send }
}

/** The "other answer" text input, shared by every family that takes free text. */
function CustomInput({
  question,
  value,
  disabled,
  translate,
  onChange,
  label,
}: {
  readonly question: SessionQuestion
  readonly value: string
  readonly disabled: boolean
  readonly translate: Translate
  readonly onChange: (next: string) => void
  readonly label?: string | undefined
}): ReactElement {
  return (
    <label className="status-board__q-custom">
      <span className="status-board__q-custom-label">{label ?? translate('question.custom')}</span>
      <input
        className="status-board__q-input"
        type="text"
        name={`custom-${question.id}`}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  )
}

/** Footer: submit button (or the reason it is unavailable), session link, status lines. */
function CardFooter({
  canAnswer,
  state,
  submitting,
  sent,
  error,
  complete,
  sessionId,
  translate,
  onOpenSession,
  note,
  hideSubmit = false,
  completeHint,
}: {
  readonly canAnswer: boolean
  readonly state: ActiveQuestion['state']
  readonly submitting: boolean
  readonly sent: boolean
  readonly error: string | null
  readonly complete: boolean
  readonly sessionId: string
  readonly translate: Translate
  readonly onOpenSession: ((sessionId: string) => void) | undefined
  readonly note?: string | undefined
  readonly hideSubmit?: boolean
  readonly completeHint?: string | undefined
}): ReactElement {
  return (
    <>
      <div className="status-board__q-footer">
        {canAnswer ? (
          hideSubmit ? null : (
            <button className="status-board__q-submit" type="submit" disabled={submitting || sent || !complete}>
              {submitting ? translate('question.submitting') : translate('question.submit')}
            </button>
          )
        ) : (
          <p className="status-board__q-note">
            {note ?? (state === 'open' ? translate('question.openNotice') : translate('question.unavailable'))}
          </p>
        )}
        {onOpenSession === undefined ? null : (
          <button className="status-board__q-open" type="button" onClick={() => onOpenSession(sessionId)}>
            {translate('question.openSession')}
          </button>
        )}
      </div>
      {canAnswer && !complete && completeHint !== undefined && !sent ? (
        <p className="status-board__q-hint">{completeHint}</p>
      ) : null}
      {error === null ? null : (
        <div className="status-board__q-failure">
          <p className="status-board__q-error" role="alert">
            {translate('question.error', { message: error })}
          </p>
          {onOpenSession === undefined ? null : (
            <button className="status-board__q-retry" type="button" onClick={() => onOpenSession(sessionId)}>
              {translate('question.retryInSession')}
            </button>
          )}
        </div>
      )}
      {sent ? (
        <p className="status-board__q-sent" role="status">
          {translate('question.sent')}
        </p>
      ) : null}
    </>
  )
}

/** A call the inline card cannot represent faithfully: summary plus a jump to the session. */
function ComplexCall({
  call,
  sessionId,
  translate,
  onOpenSession,
}: {
  readonly call: ActiveQuestion
  readonly sessionId: string
  readonly translate: Translate
  readonly onOpenSession: ((sessionId: string) => void) | undefined
}): ReactElement {
  const first = call.questions[0]
  const summary = firstParagraphOf(first?.header ?? first?.question ?? '')
  return (
    <section className="status-board__qcall" data-kind="complex_open" data-state={call.state} role="group" aria-label={translate('question.label')}>
      <p className="status-board__q-text">{summary}</p>
      <p className="status-board__q-note">{translate('question.complexNotice')}</p>
      {onOpenSession === undefined ? null : (
        <button className="status-board__q-open status-board__q-open--primary" type="button" onClick={() => onOpenSession(sessionId)}>
          {translate('question.openFull')}
        </button>
      )}
    </section>
  )
}

/** A plan review or yes/no decision: clipped preview plus Approve / Reject. */
function ConfirmCall({
  call,
  question,
  sessionId,
  translate,
  onOpenSession,
  answerQuestion,
}: {
  readonly call: ActiveQuestion
  readonly question: SessionQuestion
  readonly sessionId: string
  readonly translate: Translate
  readonly onOpenSession: ((sessionId: string) => void) | undefined
  readonly answerQuestion: AnswerQuestion | undefined
}): ReactElement {
  const approve = approveLabelOf(question)
  const decline = declineLabelOf(question)
  const previewId = `status-board-preview-${useId()}`
  const noteId = `status-board-note-${useId()}`
  const [expanded, setExpanded] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const { submitting, sent, error, send } = useSubmission(answerQuestion, sessionId, call.callId)
  const canAnswer = call.state === 'continued' && answerQuestion !== undefined && approve !== undefined && decline !== undefined
  const preview = call.summaryPreview ?? summaryPreviewOf(question.detail ?? question.question)
  const locked = !canAnswer || submitting || sent

  const decide = (label: string, custom?: string): void => {
    const trimmed = custom?.trim() ?? ''
    send({ answers: [{ id: question.id, selected: [label], ...(trimmed.length === 0 ? {} : { custom: trimmed }) }] })
  }
  const onReject = (): void => {
    if (decline === undefined) return
    // First press reveals the note box, second sends: rejection normally needs a reason.
    if (!rejecting) {
      setRejecting(true)
      return
    }
    decide(decline, note)
  }
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (locked) return
    if (rejecting) onReject()
  }

  return (
    <form className="status-board__qcall" data-kind="confirm" data-state={call.state} aria-label={translate('question.label')} onSubmit={onSubmit}>
      <p className="status-board__q-title">{question.header ?? question.question}</p>
      {question.header !== undefined && question.header !== question.question ? (
        <p className="status-board__q-text">{question.question}</p>
      ) : null}
      <div
        id={previewId}
        className="status-board__q-preview"
        data-expanded={expanded}
        tabIndex={0}
      >
        {preview}
      </div>
      <button
        type="button"
        className="status-board__q-more"
        aria-expanded={expanded}
        aria-controls={previewId}
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? translate('question.collapse') : translate('question.expand')}
      </button>
      {rejecting ? (
        <label className="status-board__q-custom" htmlFor={noteId}>
          <span className="status-board__q-custom-label">{translate('question.rejectNote')}</span>
          <input
            id={noteId}
            className="status-board__q-input"
            type="text"
            value={note}
            disabled={locked}
            autoFocus
            onChange={event => setNote(event.target.value)}
          />
        </label>
      ) : null}
      {canAnswer ? (
        <div className="status-board__q-footer">
          <button
            type="button"
            className="status-board__q-submit"
            disabled={locked || rejecting}
            onClick={() => approve !== undefined && decide(approve)}
          >
            {submitting && !rejecting ? translate('question.submitting') : translate('question.approve')}
          </button>
          <button type="button" className="status-board__q-reject" disabled={locked} onClick={onReject}>
            {submitting && rejecting ? translate('question.submitting') : translate('question.reject')}
          </button>
          {onOpenSession === undefined ? null : (
            <button className="status-board__q-open" type="button" onClick={() => onOpenSession(sessionId)}>
              {translate('question.openSession')}
            </button>
          )}
        </div>
      ) : null}
      <CardFooter
        canAnswer={canAnswer}
        hideSubmit
        state={call.state}
        submitting={submitting}
        sent={sent}
        error={error}
        complete
        sessionId={sessionId}
        translate={translate}
        onOpenSession={canAnswer ? undefined : onOpenSession}
      />
    </form>
  )
}

/** Text / single-select / multi-select: one form, one draft, one submit. */
function FormCall({
  call,
  kind,
  sessionId,
  translate,
  onOpenSession,
  answerQuestion,
}: {
  readonly call: ActiveQuestion
  readonly kind: QuestionKind
  readonly sessionId: string
  readonly translate: Translate
  readonly onOpenSession: ((sessionId: string) => void) | undefined
  readonly answerQuestion: AnswerQuestion | undefined
}): ReactElement {
  const [draft, setDraft] = useState<Record<string, Draft>>(() => initialDraft(call))
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})
  const { submitting, sent, error, send } = useSubmission(answerQuestion, sessionId, call.callId)
  const canAnswer = call.state === 'continued' && answerQuestion !== undefined
  const disabled = !canAnswer || submitting || sent
  const complete = isComplete(kind, call, draft)
  const groupId = useId()

  const choose = (question: SessionQuestion, label: string, checked: boolean): void => {
    setDraft(current => {
      const previous = draftOf(current, question.id)
      const selected =
        question.multiSelect === true
          ? checked
            ? [...previous.selected.filter(item => item !== label), label]
            : previous.selected.filter(item => item !== label)
          : checked
            ? [label]
            : []
      return {
        ...current,
        // A single-select pick clears the typed alternative: they are exclusive.
        [question.id]: { selected, custom: question.multiSelect === true ? previous.custom : '' },
      }
    })
  }

  const setCustom = (question: SessionQuestion, custom: string): void => {
    setDraft(current => {
      const previous = draftOf(current, question.id)
      return {
        ...current,
        [question.id]: {
          // A single-select custom answer supersedes the option choice; a
          // multi-select one keeps the checked labels.
          selected: question.multiSelect === true ? previous.selected : [],
          custom,
        },
      }
    })
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled || !complete) return
    send(answerBatch(call, draft))
  }

  return (
    <form className="status-board__qcall" data-kind={kind} data-state={call.state} aria-label={translate('question.label')} onSubmit={onSubmit}>
      {call.questions.map((question, index) => {
        const current = draftOf(draft, question.id)
        const legendId = `${groupId}-legend-${index}`
        const options = question.options ?? []
        const multi = question.multiSelect === true
        const showOther = kind === 'continued' || otherOpen[question.id] === true || current.custom.length > 0
        return (
          <fieldset className="status-board__q" key={question.id} disabled={disabled} aria-describedby={`${legendId}-text`}>
            <legend className="status-board__q-title" id={legendId}>
              {question.header ?? question.question}
            </legend>
            {question.header !== undefined && question.header !== question.question ? (
              <p className="status-board__q-text" id={`${legendId}-text`}>{question.question}</p>
            ) : (
              <span id={`${legendId}-text`} hidden />
            )}
            {question.detail !== undefined ? (
              <details className="status-board__q-detail">
                <summary>{translate('question.detail')}</summary>
                <p>{question.detail}</p>
              </details>
            ) : null}
            {options.length > 0 ? (
              <div
                className="status-board__q-options"
                role={multi ? 'group' : 'radiogroup'}
                aria-labelledby={legendId}
                aria-required={!multi}
              >
                {options.map((option, optionIndex) => {
                  const checked = current.selected.includes(option.label)
                  const descId = `${groupId}-${index}-${optionIndex}-desc`
                  return (
                    <label
                      key={`${question.id}-${optionIndex}`}
                      className="status-board__q-option"
                      data-selected={checked}
                      title={option.description}
                    >
                      <input
                        className="status-board__q-option-input"
                        type={multi ? 'checkbox' : 'radio'}
                        name={`${groupId}-${question.id}`}
                        value={option.label}
                        checked={checked}
                        disabled={disabled}
                        aria-describedby={option.description === undefined ? undefined : descId}
                        onChange={event => choose(question, option.label, event.target.checked)}
                      />
                      <span className="status-board__q-option-mark" data-selected={checked} data-multi={multi} aria-hidden="true" />
                      <span className="status-board__q-option-copy">
                        <span className="status-board__q-option-label">{option.label}</span>
                        {option.description === undefined ? null : (
                          <span className="status-board__q-option-desc" id={descId}>{option.description}</span>
                        )}
                      </span>
                    </label>
                  )
                })}
                <label className="status-board__q-option status-board__q-option--other" data-selected={showOther}>
                  <input
                    className="status-board__q-option-input"
                    type="checkbox"
                    checked={showOther}
                    disabled={disabled}
                    onChange={event => {
                      const open = event.target.checked
                      setOtherOpen(value => ({ ...value, [question.id]: open }))
                      if (!open) setCustom(question, '')
                    }}
                  />
                  <span className="status-board__q-option-mark" data-selected={showOther} data-multi="true" aria-hidden="true" />
                  <span className="status-board__q-option-copy">
                    <span className="status-board__q-option-label">{translate('question.other')}</span>
                  </span>
                </label>
              </div>
            ) : null}
            {showOther ? (
              <CustomInput
                question={question}
                value={current.custom}
                disabled={disabled}
                translate={translate}
                onChange={next => setCustom(question, next)}
              />
            ) : null}
            {index === 0 && kind === 'continued' ? <p className="status-board__q-hint">{translate('question.skipHint')}</p> : null}
          </fieldset>
        )
      })}
      <CardFooter
        canAnswer={canAnswer}
        state={call.state}
        submitting={submitting}
        sent={sent}
        error={error}
        complete={complete}
        sessionId={sessionId}
        translate={translate}
        onOpenSession={onOpenSession}
        completeHint={kind === 'multi_select' ? translate('question.selectAtLeastOne') : translate('question.selectOne')}
      />
    </form>
  )
}

/** One `ask_user_question` call, dispatched to the card for its family. */
function QuestionCall({
  call,
  sessionId,
  translate,
  onOpenSession,
  answerQuestion,
}: {
  readonly call: ActiveQuestion
  readonly sessionId: string
  readonly translate: Translate
  readonly onOpenSession: ((sessionId: string) => void) | undefined
  readonly answerQuestion: AnswerQuestion | undefined
}): ReactElement {
  const kind = kindOf(call)
  const [first] = call.questions
  if (kind === 'complex_open' || first === undefined) {
    return <ComplexCall call={call} sessionId={sessionId} translate={translate} onOpenSession={onOpenSession} />
  }
  if (kind === 'confirm') {
    return (
      <ConfirmCall
        call={call}
        question={first}
        sessionId={sessionId}
        translate={translate}
        onOpenSession={onOpenSession}
        answerQuestion={answerQuestion}
      />
    )
  }
  return (
    <FormCall
      call={call}
      kind={kind}
      sessionId={sessionId}
      translate={translate}
      onOpenSession={onOpenSession}
      answerQuestion={answerQuestion}
    />
  )
}

/**
 * The inline card for one decision row.
 *
 * @param props - the row, its active calls, and the answer/navigation seams.
 */
export function QuestionCard({
  entry,
  translate,
  onOpenSession,
  answerQuestion,
}: {
  readonly entry: BoardEntry
  readonly translate: Translate
  readonly onOpenSession: ((sessionId: string) => void) | undefined
  readonly answerQuestion: AnswerQuestion | undefined
}): ReactElement | null {
  const calls = entry.questions ?? []
  const signature = calls.map(callSignature).join('|')
  // Tell the user when the question under their cursor was replaced, so a blank
  // card does not look like a lost draft.
  const lastSeen = useRef(signature)
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    if (lastSeen.current === signature) return undefined
    const hadQuestion = lastSeen.current.length > 0
    lastSeen.current = signature
    if (!hadQuestion || signature.length === 0) return undefined
    setChanged(true)
    const timer = setTimeout(() => setChanged(false), 4_000)
    return () => clearTimeout(timer)
  }, [signature])

  if (calls.length === 0) return null
  return (
    <div className="status-board__qcard">
      {changed ? (
        <p className="status-board__q-note" role="status">
          {translate('question.changed')}
        </p>
      ) : null}
      {calls.map(call => (
        // Keyed by the signature: a different question remounts with a blank draft.
        <QuestionCall
          key={callSignature(call)}
          call={call}
          sessionId={entry.id}
          translate={translate}
          onOpenSession={onOpenSession}
          answerQuestion={answerQuestion}
        />
      ))}
    </div>
  )
}
