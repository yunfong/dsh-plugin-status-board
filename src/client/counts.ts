/**
 * The global counters shared by the floating button and the collapsed badge.
 *
 * One definition means the two surfaces cannot disagree. They are always derived
 * from the UNFILTERED board (`BoardState.board`): the sentinel must not be
 * silenced by whatever the user typed into the panel's filter.
 * @module dsh-plugin-status-board/client/counts
 */

import type { BoardSnapshot } from '../shared/types.ts'
import { countCompletionUnread, type SessionStatusMap } from './completion-unread.ts'

/** Counters in the order the ring draws them. */
export interface GlobalCounts {
  readonly decision: number
  /** Running sessions, including running automated ones. */
  readonly executing: number
  /** Finished and not yet opened, from the human "recent" board. */
  readonly unread: number
  /** Everything else that is only history, including finished automated runs. */
  readonly recent: number
  /** Needs a person now: decisions plus unread completions. */
  readonly urgent: number
  readonly total: number
}

/** Rows of one board, or none when the board is absent. */
function entriesOf(board: BoardSnapshot, id: 'decision' | 'executing' | 'recent' | 'automated') {
  return board.buckets.find(candidate => candidate.id === id)?.entries ?? []
}

/**
 * Summarise a board into the ring's counters.
 *
 * Automated sessions are folded in by what they are doing: a running one is
 * work in flight, a finished one is history. They never become "unread": a job
 * firing every minute must not keep the urgent badge lit.
 */
export function summarizeBoard(board: BoardSnapshot, statuses: SessionStatusMap): GlobalCounts {
  const decision = entriesOf(board, 'decision').length
  const recentEntries = entriesOf(board, 'recent')
  const automated = entriesOf(board, 'automated')
  const automatedRunning = automated.filter(entry => entry.running === true).length
  const unread = countCompletionUnread(statuses, recentEntries)
  const executing = entriesOf(board, 'executing').length + automatedRunning
  const recent = Math.max(0, recentEntries.length - unread) + (automated.length - automatedRunning)
  const urgent = decision + unread
  return { decision, executing, unread, recent, urgent, total: decision + executing + unread + recent }
}
