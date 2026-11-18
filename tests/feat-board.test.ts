/**
 * v0.6 – v0.8 board algorithms: filtering (FEAT-02), SLA grading and ordering plus
 * the automated board (FEAT-04), and the shared counters (FEAT-01).
 */
import { describe, expect, it } from 'vitest'
import {
  applyBoardFilter,
  buildBoard,
  classifySession,
  compareDecisions,
  decisionSeverity,
  effectiveScope,
  isFilterActive,
} from '../src/shared/board.ts'
import { summarizeBoard } from '../src/client/counts.ts'
import type { BoardFilterState, SessionSignal } from '../src/shared/types.ts'

const MIN = 60_000
const NOW = 1_700_000_000_000
const BASE = { recentWindowHours: 168, maxRecent: 20 }

function signal(overrides: Partial<SessionSignal> & { id: string }): SessionSignal {
  return { title: overrides.id, running: false, awaitingDecision: false, lastActivityAt: NOW, ...overrides }
}
const filter = (patch: Partial<BoardFilterState> = {}): BoardFilterState => ({ workspaceScope: 'all', keyword: '', ...patch })

describe('applyBoardFilter', () => {
  const sessions = [
    signal({ id: 'a', title: 'Fix Parser', workspaceId: 'w1', workspaceName: 'Alpha' }),
    signal({ id: 'b', title: 'Write docs', workspaceId: 'w2', workspaceName: 'Beta' }),
    signal({ id: 'c', title: 'Parser perf', workspaceId: 'w2', workspaceName: 'Beta' }),
    signal({ id: 'd', title: 'No workspace' }),
  ]
  const ids = (list: readonly SessionSignal[]): string[] => list.map(item => item.id)

  it('keeps everything with the default filter', () => {
    expect(ids(applyBoardFilter(sessions, filter(), 'w1'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('narrows to the active workspace in current scope', () => {
    expect(ids(applyBoardFilter(sessions, filter({ workspaceScope: 'current' }), 'w2'))).toEqual(['b', 'c'])
  })

  it('falls back to all workspaces when none is active', () => {
    expect(ids(applyBoardFilter(sessions, filter({ workspaceScope: 'current' }), undefined))).toEqual(['a', 'b', 'c', 'd'])
    expect(effectiveScope(filter({ workspaceScope: 'current' }), undefined)).toBe('all')
  })

  it('matches the keyword case-insensitively on title and workspace name', () => {
    expect(ids(applyBoardFilter(sessions, filter({ keyword: 'PARSER' }), undefined))).toEqual(['a', 'c'])
    expect(ids(applyBoardFilter(sessions, filter({ keyword: 'beta' }), undefined))).toEqual(['b', 'c'])
  })

  it('combines scope and keyword', () => {
    expect(ids(applyBoardFilter(sessions, filter({ workspaceScope: 'current', keyword: 'parser' }), 'w2'))).toEqual(['c'])
  })

  it('ignores a whitespace-only keyword', () => {
    expect(ids(applyBoardFilter(sessions, filter({ keyword: '   ' }), undefined))).toHaveLength(4)
  })

  it('reports whether anything is filtered', () => {
    expect(isFilterActive(filter(), 'w1')).toBe(false)
    expect(isFilterActive(filter({ keyword: 'x' }), undefined)).toBe(true)
    expect(isFilterActive(filter({ workspaceScope: 'current' }), 'w1')).toBe(true)
    // `current` without an active workspace narrows nothing, so no "filtered" badge.
    expect(isFilterActive(filter({ workspaceScope: 'current' }), undefined)).toBe(false)
  })

  it('filters before the recent cap, so counts describe what is in view', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      signal({ id: `r${i}`, title: i < 3 ? `keep ${i}` : `drop ${i}`, lastActivityAt: NOW - i }),
    )
    const board = buildBoard(applyBoardFilter(many, filter({ keyword: 'keep' }), undefined), { ...BASE, maxRecent: 2 }, NOW)
    expect(board.counts.recent).toBe(2)
    expect(board.buckets.find(b => b.id === 'recent')?.truncated).toBe(1)
  })
})

describe('decisionSeverity', () => {
  const t = { warnMinutes: 15, criticalMinutes: 60 }
  it('grades by the thresholds', () => {
    expect(decisionSeverity(14 * MIN, t)).toBe('normal')
    expect(decisionSeverity(15 * MIN, t)).toBe('warning')
    expect(decisionSeverity(59 * MIN, t)).toBe('warning')
    expect(decisionSeverity(60 * MIN, t)).toBe('critical')
  })
  it('treats an unknown ask time as normal', () => {
    expect(decisionSeverity(undefined, t)).toBe('normal')
    expect(decisionSeverity(Number.NaN, t)).toBe('normal')
  })
  it('lifts a critical threshold that sits below the warning one', () => {
    expect(decisionSeverity(20 * MIN, { warnMinutes: 30, criticalMinutes: 5 })).toBe('normal')
    expect(decisionSeverity(30 * MIN, { warnMinutes: 30, criticalMinutes: 5 })).toBe('critical')
  })
})

describe('decision ordering', () => {
  const config = { ...BASE, decisionWarnMinutes: 15, decisionCriticalMinutes: 60 }
  const ids = (board: ReturnType<typeof buildBoard>): string[] => board.buckets[0]?.entries.map(e => e.id) ?? []

  it('puts critical rows first, longest blocked first', () => {
    const board = buildBoard(
      [
        signal({ id: 'fresh', awaitingDecision: true, askedAtMs: NOW - 2 * MIN, lastActivityAt: NOW }),
        signal({ id: 'old', awaitingDecision: true, askedAtMs: NOW - 120 * MIN, lastActivityAt: NOW - 5 }),
        signal({ id: 'oldest', awaitingDecision: true, askedAtMs: NOW - 300 * MIN, lastActivityAt: NOW - 9 }),
        signal({ id: 'warn', awaitingDecision: true, askedAtMs: NOW - 20 * MIN, lastActivityAt: NOW - 1 }),
      ],
      config,
      NOW,
    )
    expect(ids(board)).toEqual(['oldest', 'old', 'fresh', 'warn'])
    expect(board.buckets[0]?.entries.map(e => e.severity)).toEqual(['critical', 'critical', 'normal', 'warning'])
  })

  it('is stable for equal waits and does not flip between snapshots', () => {
    const rows = [
      signal({ id: 'b', awaitingDecision: true, askedAtMs: NOW - 90 * MIN }),
      signal({ id: 'a', awaitingDecision: true, askedAtMs: NOW - 90 * MIN }),
    ]
    expect(ids(buildBoard(rows, config, NOW))).toEqual(['a', 'b'])
    expect(ids(buildBoard([...rows].reverse(), config, NOW))).toEqual(['a', 'b'])
  })

  it('leaves rows without an ask time at normal and in recency order', () => {
    const board = buildBoard(
      [
        signal({ id: 'x', awaitingDecision: true, lastActivityAt: NOW - 10 }),
        signal({ id: 'y', awaitingDecision: true, lastActivityAt: NOW }),
      ],
      config,
      NOW,
    )
    expect(ids(board)).toEqual(['y', 'x'])
    expect(board.buckets[0]?.entries.every(e => e.severity === 'normal')).toBe(true)
  })

  it('exposes compareDecisions for callers that sort entries themselves', () => {
    const a = { id: 'a', title: 'a', lastActivityAt: 1, severity: 'critical', waitingMs: 5 } as const
    const b = { id: 'b', title: 'b', lastActivityAt: 9, severity: 'normal' } as const
    expect([b, a].sort(compareDecisions).map(e => e.id)).toEqual(['a', 'b'])
  })
})

describe('automated board', () => {
  const on = { ...BASE, separateAutomatedSessions: true }

  it('keeps the classic three boards when the option is off', () => {
    const board = buildBoard([signal({ id: 'cron', isAutomatedOrigin: true })], BASE, NOW)
    expect(board.buckets.map(b => b.id)).toEqual(['decision', 'executing', 'recent'])
    expect(board.counts.recent).toBe(1)
    expect(board.counts.automated).toBeUndefined()
  })

  it('adds the board between executing and recent when on', () => {
    const board = buildBoard([signal({ id: 'cron', isAutomatedOrigin: true })], on, NOW)
    expect(board.buckets.map(b => b.id)).toEqual(['decision', 'executing', 'automated', 'recent'])
    expect(board.counts.automated).toBe(1)
    expect(board.counts.recent).toBe(0)
  })

  it('files a running automated session under automated, not executing', () => {
    const board = buildBoard([signal({ id: 'cron', isAutomatedOrigin: true, running: true })], on, NOW)
    expect(board.counts).toMatchObject({ executing: 0, automated: 1 })
  })

  it('lets a question lift an automated session into decision', () => {
    const signalAsk = signal({ id: 'cron', isAutomatedOrigin: true, running: true, awaitingDecision: true })
    expect(classifySession(signalAsk, true)).toBe('decision')
    const board = buildBoard([signalAsk], on, NOW)
    expect(board.counts).toMatchObject({ decision: 1, automated: 0 })
  })

  it('never classifies as automated when the option is off', () => {
    expect(classifySession(signal({ id: 'x', isAutomatedOrigin: true }), false)).toBe('recent')
  })

  it('keeps a running automated session visible even beyond the cap', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      signal({ id: `c${i}`, isAutomatedOrigin: true, running: true, lastActivityAt: NOW - i }),
    )
    const board = buildBoard(rows, { ...on, maxRecent: 1 }, NOW)
    expect(board.counts.automated).toBe(4)
  })
})

describe('summarizeBoard', () => {
  it('counts urgent as decisions plus unread completions', () => {
    const board = buildBoard(
      [
        signal({ id: 'd1', awaitingDecision: true }),
        signal({ id: 'd2', awaitingDecision: true }),
        signal({ id: 'u1' }),
        signal({ id: 'r1' }),
        signal({ id: 'e1', running: true }),
      ],
      BASE,
      NOW,
    )
    const summary = summarizeBoard(board, new Map([['u1', { completionUnread: true }]]))
    expect(summary).toMatchObject({ decision: 2, unread: 1, executing: 1, recent: 1, urgent: 3, total: 5 })
  })

  it('folds automated sessions into running or history, never into urgent', () => {
    const board = buildBoard(
      [
        signal({ id: 'a1', isAutomatedOrigin: true, running: true }),
        signal({ id: 'a2', isAutomatedOrigin: true }),
      ],
      { ...BASE, separateAutomatedSessions: true },
      NOW,
    )
    const summary = summarizeBoard(board, new Map([['a2', { completionUnread: true }]]))
    expect(summary).toMatchObject({ executing: 1, recent: 1, unread: 0, urgent: 0 })
  })
})
