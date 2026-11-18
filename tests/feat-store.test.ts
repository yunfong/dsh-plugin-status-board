/**
 * Store additions: filter persistence, SLA clock, ticker, visibility, workspace service.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILTER_STORAGE_KEY,
  SLA_TICK_MS,
  createBoardStore,
  parseCollapse,
  parseWorkspaceScope,
  toStatusBoardConfig,
} from '../src/client/store.ts'
import type { CollapseStorage, WorkspacesFace } from '../src/client/store.ts'
import { COLLAPSE_STORAGE_KEY } from '../src/client/store.ts'
import { resolveConfig } from '../src/shared/config.ts'
import type { SessionListLike, SessionSummaryLike } from '../src/client/session-source.ts'

function memoryStorage(): CollapseStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  }
}

function mutable(rows: SessionSummaryLike[], projections: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  let snapshot: SessionListLike = {
    byId: Object.fromEntries(rows.map(r => [r.id as string, r])),
    phase: 'ready',
    projectionsBySession: projections as never,
  }
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    publish(next: SessionSummaryLike[], nextProjections: Record<string, unknown> = {}) {
      snapshot = {
        byId: Object.fromEntries(next.map(r => [r.id as string, r])),
        phase: 'ready',
        projectionsBySession: nextProjections as never,
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

const ask = { values: { userQuestions: { active: [{ callId: 'c', state: 'continued', questions: [{ id: 'q', question: 'x' }] }] } } }
const row = (id: string, extra: Partial<SessionSummaryLike> = {}): SessionSummaryLike => ({ id, displayTitle: id, running: false, updatedAt: Date.now(), ...extra })
const base = { locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} }, loadConfig: () => Promise.resolve(undefined) }

describe('filter', () => {
  it('starts open, and persists only the scope', () => {
    const storage = memoryStorage()
    const store = createBoardStore({ ...base, sessions: mutable([row('a')]), storage })
    expect(store.getSnapshot().filter).toEqual({ workspaceScope: 'all', keyword: '' })
    store.setFilter({ keyword: 'abc' })
    expect(storage.data.has(FILTER_STORAGE_KEY)).toBe(false)
    store.setFilter({ workspaceScope: 'current' })
    expect(JSON.parse(storage.data.get(FILTER_STORAGE_KEY) ?? '{}')).toEqual({ workspaceScope: 'current' })
    store.dispose()
  })

  it('restores the scope on the next load but not the keyword', () => {
    const storage = memoryStorage()
    storage.data.set(FILTER_STORAGE_KEY, JSON.stringify({ workspaceScope: 'current' }))
    const store = createBoardStore({ ...base, sessions: mutable([row('a')]), storage })
    expect(store.getSnapshot().filter).toEqual({ workspaceScope: 'current', keyword: '' })
    store.dispose()
  })

  it('recovers from corrupt or unknown stored values', () => {
    expect(parseWorkspaceScope('{')).toBe('all')
    expect(parseWorkspaceScope('{"workspaceScope":"everything"}')).toBe('all')
    expect(parseWorkspaceScope(null)).toBe('all')
  })

  it('keeps the filter in memory when storage throws', () => {
    const storage: CollapseStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {},
    }
    const store = createBoardStore({ ...base, sessions: mutable([row('a')]), storage })
    store.setFilter({ workspaceScope: 'current' })
    expect(store.getSnapshot().filter.workspaceScope).toBe('current')
    store.dispose()
  })

  it('filters the panel board but never the global board', () => {
    const store = createBoardStore({ ...base, sessions: mutable([row('apple'), row('banana'), row('cherry', { running: true })]) })
    store.setFilter({ keyword: 'apple' })
    const state = store.getSnapshot()
    expect(state.panelBoard.counts.recent).toBe(1)
    expect(state.board.counts.recent).toBe(2)
    expect(state.board.counts.executing).toBe(1)
    expect(state.panelBoard.counts.executing).toBe(0)
    store.dispose()
  })

  it('uses the same board object when nothing is filtered', () => {
    const store = createBoardStore({ ...base, sessions: mutable([row('a')]) })
    expect(store.getSnapshot().panelBoard).toBe(store.getSnapshot().board)
    store.dispose()
  })

  it('narrows to the current workspace through the workspace service', () => {
    const workspaces: WorkspacesFace = {
      list: {
        getSnapshot: () => ({
          items: [
            { workspaceId: 'w1', title: 'One', path: '/1', sessionIds: ['a'] },
            { workspaceId: 'w2', title: 'Two', path: '/2', sessionIds: ['b'] },
          ],
        }),
        subscribe: () => () => {},
      },
    }
    const store = createBoardStore({
      ...base,
      workspaces,
      sessions: mutable([row('a', { retainedBy: { mainView: 1 } }), row('b')]),
    })
    expect(store.getSnapshot().activeWorkspaceId).toBe('w1')
    store.setFilter({ workspaceScope: 'current' })
    expect(store.getSnapshot().panelBoard.counts.recent).toBe(1)
    expect(store.getSnapshot().board.counts.recent).toBe(2)
    store.dispose()
  })

  it('attaches a workspace service that mounts late, and detaches it', () => {
    const store = createBoardStore({ ...base, sessions: mutable([row('a', { retainedBy: { mainView: 1 } })]) })
    expect(store.getSnapshot().activeWorkspaceId).toBeUndefined()
    const detach = store.attachWorkspaces({
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: ['a'] }] }), subscribe: () => () => {} },
    })
    expect(store.getSnapshot().activeWorkspaceId).toBe('w1')
    detach()
    expect(store.getSnapshot().activeWorkspaceId).toBeUndefined()
    store.dispose()
  })
})

describe('decision clock and ticker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('starts the clock when a session first waits, and clears it when it stops', () => {
    const sessions = mutable([row('s')], { s: ask })
    const store = createBoardStore({ ...base, sessions })
    expect(store.getSnapshot().board.buckets[0]?.entries[0]?.waitingMs).toBe(0)
    vi.setSystemTime(1_700_000_000_000 + 20 * 60_000)
    sessions.publish([row('s')], { s: ask })
    expect(store.getSnapshot().board.buckets[0]?.entries[0]).toMatchObject({ waitingMs: 20 * 60_000, severity: 'warning' })

    // Answered elsewhere: the key goes, so a new question starts a fresh clock.
    sessions.publish([row('s')], {})
    vi.setSystemTime(1_700_000_000_000 + 90 * 60_000)
    sessions.publish([row('s')], { s: ask })
    expect(store.getSnapshot().board.buckets[0]?.entries[0]?.waitingMs).toBe(0)
    store.dispose()
  })

  it('prefers the snapshot\'s own ask time over the first-seen fallback', () => {
    const asked = { values: { userQuestions: { active: [{ callId: 'c', state: 'continued', createdAt: 1_700_000_000_000 - 70 * 60_000, questions: [{ id: 'q', question: 'x' }] }] } } }
    const store = createBoardStore({ ...base, sessions: mutable([row('s')], { s: asked }) })
    expect(store.getSnapshot().board.buckets[0]?.entries[0]).toMatchObject({ severity: 'critical' })
    store.dispose()
  })

  it('refreshes wait times every 30 seconds while a decision is pending', () => {
    const store = createBoardStore({ ...base, sessions: mutable([row('s')], { s: ask }) })
    const listener = vi.fn()
    store.subscribe(listener)
    vi.advanceTimersByTime(SLA_TICK_MS * 2)
    // The displayed unit is whole minutes, so two 30s ticks cross exactly one change.
    expect(listener).toHaveBeenCalled()
    store.dispose()
  })

  it('runs no timer at all without a pending decision', () => {
    const store = createBoardStore({ ...base, sessions: mutable([row('s')]) })
    expect(vi.getTimerCount()).toBe(0)
    store.dispose()
  })

  it('stops the timer when the last decision goes away and when disposed', () => {
    const sessions = mutable([row('s')], { s: ask })
    const store = createBoardStore({ ...base, sessions })
    expect(vi.getTimerCount()).toBe(1)
    sessions.publish([row('s')], {})
    expect(vi.getTimerCount()).toBe(0)
    sessions.publish([row('s')], { s: ask })
    expect(vi.getTimerCount()).toBe(1)
    store.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses while the page is hidden and refreshes on return', () => {
    let hidden = false
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    const store = createBoardStore({ ...base, sessions: mutable([row('s')], { s: ask }) })
    expect(vi.getTimerCount()).toBe(1)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(1_700_000_000_000 + 5 * 60_000)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)
    expect(store.getSnapshot().board.buckets[0]?.entries[0]?.waitingMs).toBe(5 * 60_000)
    store.dispose()
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

  it('removes its visibility listener on dispose', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    createBoardStore({ ...base, sessions: mutable([row('s')]) }).dispose()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    remove.mockRestore()
  })
})

describe('collapse persistence with the automated board', () => {
  it('accepts a legacy record without automated', () => {
    expect(parseCollapse('{"decision":true,"executing":false,"recent":true}')).toEqual({
      decision: true,
      executing: false,
      automated: false,
      recent: true,
    })
  })
  it('still rejects a record missing a classic board', () => {
    expect(parseCollapse('{"decision":true,"recent":true}')).toBeUndefined()
  })
  it('restores a legacy record from storage', () => {
    const storage = memoryStorage()
    storage.data.set(COLLAPSE_STORAGE_KEY, '{"decision":true,"executing":true,"recent":false}')
    const store = createBoardStore({ ...base, sessions: mutable([]), storage })
    expect(store.getSnapshot().collapse).toMatchObject({ decision: true, executing: true, recent: false })
    store.dispose()
  })
})

describe('published configuration', () => {
  it('passes the new keys through and drops bad ones', () => {
    const config = toStatusBoardConfig({
      showCollapsedBadge: false,
      decisionWarnMinutes: 5,
      decisionCriticalMinutes: 'x',
      separateAutomatedSessions: true,
      panelDensity: 'compact',
    })
    expect(config).toEqual({ showCollapsedBadge: false, decisionWarnMinutes: 5, separateAutomatedSessions: true, panelDensity: 'compact' })
    expect(resolveConfig(config).decisionCriticalMinutes).toBe(60)
  })
  it('adds the automated board once the configuration enables it', async () => {
    const store = createBoardStore({
      ...base,
      sessions: mutable([row('c', { origin: 'cron' as never })]),
      loadConfig: () => Promise.resolve(resolveConfig({ separateAutomatedSessions: true })),
    })
    expect(store.getSnapshot().board.buckets.map(b => b.id)).not.toContain('automated')
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().board.buckets.map(b => b.id)).toContain('automated')
    store.dispose()
  })
})
