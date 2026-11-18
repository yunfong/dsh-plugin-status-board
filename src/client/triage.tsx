/**
 * Batch triage for the finished boards (FEAT-03).
 *
 * Two host-gated actions, both offered only on "Completed unread" and "Recent":
 *
 * - **Archive**: calls the host's own `uiWorkspace.archiveSession` per session.
 * - **Mark all read**: calls a host write API when one exists. The board never
 *   keeps a private "read" table: the green dot has to stay the host's single
 *   fact (see `completion-unread.ts`), so without a host API the control is
 *   simply not rendered.
 *
 * Neither action is ever offered for the active boards, so a running or waiting
 * session cannot be archived from here by mistake.
 * @module dsh-plugin-status-board/client/triage
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { runBatch, type BatchFailure } from '../shared/batch.ts'
import type { Translate } from '../shared/i18n.ts'
import type { BoardEntry } from '../shared/types.ts'

/** A host write call for one session. Rejects with a readable message. */
export type SessionAction = (sessionId: string) => Promise<void>

/** At or above this many sessions the action asks first. */
export const CONFIRM_THRESHOLD = 3

/** Which of the two actions is running or awaiting confirmation. */
export type TriageKind = 'archive' | 'markRead'

/** Boards that may offer triage actions. */
export function isTriageBoard(id: string): boolean {
  return id === 'unread' || id === 'recent'
}

/** Observable state of one board's triage controls. */
export interface TriageState {
  readonly pending: TriageKind | undefined
  readonly busy: boolean
  readonly progress: { readonly done: number; readonly total: number } | undefined
  readonly failures: readonly BatchFailure[]
  readonly request: (kind: TriageKind) => void
  readonly confirm: () => void
  readonly cancel: () => void
}

/**
 * Drive the triage controls of one board.
 *
 * @param entries - the rows the board lists right now (the action's target set).
 * @param actions - the host write calls that exist; a missing one hides its button.
 */
export function useTriage(
  entries: readonly BoardEntry[],
  actions: { readonly archive?: SessionAction | undefined; readonly markRead?: SessionAction | undefined },
): TriageState {
  const [pending, setPending] = useState<TriageKind | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined)
  const [failures, setFailures] = useState<readonly BatchFailure[]>([])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    (kind: TriageKind): void => {
      const task = kind === 'archive' ? actions.archive : actions.markRead
      if (task === undefined || busy) return
      const ids = entries.map(entry => entry.id)
      if (ids.length === 0) return
      setPending(undefined)
      setBusy(true)
      setFailures([])
      setProgress({ done: 0, total: ids.length })
      void runBatch(ids, task, (done, total) => {
        if (alive.current) setProgress({ done, total })
      }).then(result => {
        if (!alive.current) return
        setBusy(false)
        setProgress(undefined)
        setFailures(result.failed)
      })
    },
    [actions.archive, actions.markRead, busy, entries],
  )

  const request = useCallback(
    (kind: TriageKind): void => {
      if (busy) return
      // Small batches run at once; a larger one asks first, inline, never with a
      // blocking browser dialog.
      if (entries.length >= CONFIRM_THRESHOLD) setPending(kind)
      else run(kind)
    },
    [busy, entries.length, run],
  )

  return {
    pending,
    busy,
    progress,
    failures,
    request,
    confirm: () => {
      if (pending !== undefined) run(pending)
    },
    cancel: () => setPending(undefined),
  }
}

/** The action buttons that sit on the board's header row. */
export function TriageButtons({
  name,
  count,
  state,
  canArchive,
  canMarkRead,
  translate,
}: {
  readonly name: string
  readonly count: number
  readonly state: TriageState
  readonly canArchive: boolean
  readonly canMarkRead: boolean
  readonly translate: Translate
}): ReactElement | null {
  if (count === 0 || (!canArchive && !canMarkRead)) return null
  const busyText =
    state.progress === undefined
      ? undefined
      : translate('triage.busy', { done: state.progress.done, total: state.progress.total })
  return (
    <span className="status-board__triage-actions">
      {canMarkRead ? (
        <button
          type="button"
          className="status-board__triage-button"
          disabled={state.busy}
          aria-label={translate('triage.markAllReadLabel', { name })}
          onClick={() => state.request('markRead')}
        >
          {translate('triage.markAllRead')}
        </button>
      ) : null}
      {canArchive ? (
        <button
          type="button"
          className="status-board__triage-button"
          disabled={state.busy}
          aria-label={translate('triage.archiveAllLabel', { name })}
          onClick={() => state.request('archive')}
        >
          {state.busy && busyText !== undefined ? busyText : translate('triage.archiveAll')}
        </button>
      ) : null}
    </span>
  )
}

/** The inline confirmation, progress and error strips shown under the header. */
export function TriageNotices({
  count,
  state,
  translate,
}: {
  readonly count: number
  readonly state: TriageState
  readonly translate: Translate
}): ReactElement | null {
  const first = state.failures[0]
  if (state.pending === undefined && first === undefined) return null
  return (
    <div className="status-board__triage-notices">
      {state.pending === undefined ? null : (
        <div className="status-board__triage-confirm" role="group" aria-label={translate('triage.confirm', { count })}>
          <span className="status-board__triage-confirm-text">{translate('triage.confirm', { count })}</span>
          <button type="button" className="status-board__triage-yes" onClick={state.confirm}>
            {translate('triage.confirmYes')}
          </button>
          <button type="button" className="status-board__triage-no" onClick={state.cancel}>
            {translate('triage.confirmNo')}
          </button>
        </div>
      )}
      {first === undefined ? null : (
        <p className="status-board__triage-error" role="status">
          {translate('triage.failed', { count: state.failures.length, message: first.message })}
        </p>
      )}
    </div>
  )
}
