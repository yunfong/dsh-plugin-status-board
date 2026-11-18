/**
 * FEAT-01: the badge on the collapsed sidebar's expand button.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BADGE_CAP, CollapsedBadge, badgeText, registerCollapsedBadge } from '../src/client/collapsed-badge.tsx'
import { buildBoard } from '../src/shared/board.ts'
import { CONFIG_DEFAULTS, resolveConfig } from '../src/shared/config.ts'
import type { BoardState, BoardStore } from '../src/client/store.ts'
import type { ResolvedStatusBoardConfig, SessionSignal } from '../src/shared/types.ts'
import { BADGE_CSS } from '../src/client/styles.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NOW = 1_700_000_000_000

const sig = (id: string, extra: Partial<SessionSignal> = {}): SessionSignal => ({
  id,
  title: id,
  running: false,
  awaitingDecision: false,
  lastActivityAt: NOW,
  ...extra,
})

/** A store double whose config and board can change, to exercise live reconfiguration. */
function fakeStore(signals: readonly SessionSignal[], config: ResolvedStatusBoardConfig = CONFIG_DEFAULTS) {
  const listeners = new Set<() => void>()
  const make = (cfg: ResolvedStatusBoardConfig, sigs: readonly SessionSignal[]): BoardState => {
    const board = buildBoard(sigs, cfg, NOW)
    return {
      status: 'ready',
      board,
      panelBoard: board,
      filter: { workspaceScope: 'all', keyword: '' },
      activeWorkspaceId: undefined,
      config: cfg,
      collapse: { decision: false, executing: false, automated: false, recent: false },
      locale: 'en',
    } as unknown as BoardState
  }
  let state = make(config, signals)
  const store = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggle() {},
    setFilter() {},
    attachWorkspaces: () => () => {},
    setPendingApprovals() {},
    dispose() {},
  } as unknown as BoardStore
  return {
    store,
    set(cfg: Partial<ResolvedStatusBoardConfig>, sigs: readonly SessionSignal[] = signals) {
      state = make({ ...state.config, ...cfg }, sigs)
      for (const l of [...listeners]) l()
    },
    listeners,
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount())
    m.container.remove()
  }
  delete (globalThis as Record<string, unknown>).dshDesktop
})

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(node))
  mounted.push({ root, container })
  return container
}
const statusHook = (map: Map<string, { completionUnread?: boolean }>) => ((selector: (m: never) => never) => selector(map as never)) as never
const decisions = (n: number) => Array.from({ length: n }, (_, i) => sig(`d${i}`, { awaitingDecision: true }))

describe('badge counting', () => {
  it('shows the amber total for 2 decisions plus 1 unread completion', () => {
    const { store } = fakeStore([...decisions(2), sig('u')])
    const container = mount(createElement(CollapsedBadge, { store, useSessionStatus: statusHook(new Map([['u', { completionUnread: true }]])) }))
    const badge = container.querySelector('.status-board__toggle-badge')
    expect(badge?.textContent).toBe('3')
    expect(badge?.getAttribute('data-tone')).toBe('decision')
  })

  it('uses the completion tone when only unread completions exist', () => {
    const { store } = fakeStore([sig('u')])
    const container = mount(createElement(CollapsedBadge, { store, useSessionStatus: statusHook(new Map([['u', { completionUnread: true }]])) }))
    expect(container.querySelector('.status-board__toggle-badge')?.getAttribute('data-tone')).toBe('unread')
  })

  it('caps the number at 99+', () => {
    expect(badgeText(99)).toBe('99')
    expect(badgeText(BADGE_CAP + 1)).toBe('99+')
    const { store } = fakeStore(decisions(150))
    const container = mount(createElement(CollapsedBadge, { store }))
    expect(container.querySelector('.status-board__toggle-badge')?.textContent).toBe('99+')
  })

  it('shows a number-less dot while only background work runs', () => {
    const { store } = fakeStore([sig('e', { running: true })])
    const container = mount(createElement(CollapsedBadge, { store }))
    expect(container.querySelector('.status-board__toggle-badge')).toBeNull()
    expect(container.querySelector('.status-board__toggle-dot')?.textContent).toBe('')
  })

  it('renders nothing when idle', () => {
    const { store } = fakeStore([sig('r')])
    const container = mount(createElement(CollapsedBadge, { store }))
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the option is off, even with decisions', () => {
    const { store } = fakeStore(decisions(2), resolveConfig({ showCollapsedBadge: false }))
    expect(mount(createElement(CollapsedBadge, { store })).innerHTML).toBe('')
  })

  it('is non-interactive and hidden from assistive technology', () => {
    const { store } = fakeStore(decisions(1))
    const container = mount(createElement(CollapsedBadge, { store }))
    const badge = container.querySelector('.status-board__toggle-badge')
    expect(badge?.getAttribute('aria-hidden')).toBe('true')
    expect(BADGE_CSS).toMatch(/\.status-board__toggle-badge[^}]*pointer-events:\s*none/)
    expect(BADGE_CSS).toMatch(/\.status-board__toggle-dot[^}]*pointer-events:\s*none/)
    expect(container.querySelector('button, a, input')).toBeNull()
  })

  it('does not swallow a click that lands on it', () => {
    const { store } = fakeStore(decisions(1))
    const clicked = vi.fn()
    const container = mount(createElement('button', { onClick: clicked }, createElement(CollapsedBadge, { store })))
    act(() => {
      container.querySelector('.status-board__toggle-badge')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('follows the global board, not a filtered panel board', () => {
    const { store } = fakeStore(decisions(2))
    const state = store.getSnapshot()
    ;(state as unknown as { panelBoard: unknown }).panelBoard = buildBoard([], CONFIG_DEFAULTS, NOW)
    const container = mount(createElement(CollapsedBadge, { store }))
    expect(container.querySelector('.status-board__toggle-badge')?.textContent).toBe('2')
  })

  it('keeps the stylesheet token-driven and honours reduced motion', () => {
    expect(BADGE_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(BADGE_CSS).not.toMatch(/rgba?\(/)
    expect(BADGE_CSS).toContain('var(--dsw-alias-')
    expect(BADGE_CSS).toMatch(/prefers-reduced-motion: reduce\)\s*{[^}]*\.status-board__toggle-dot\s*{\s*animation:\s*none/)
  })
})

describe('slot registration', () => {
  function slots(refuse: ReadonlySet<number> = new Set()) {
    const calls: Array<Record<string, unknown>> = []
    const disposers: Array<ReturnType<typeof vi.fn>> = []
    return {
      calls,
      disposers,
      slots: {
        register(options: Record<string, unknown>) {
          const priority = (options.priority as number | undefined) ?? 0
          calls.push(options)
          if (refuse.has(priority)) throw new Error(`single slot "sidebar.toggle.badge" already has a registration at priority ${priority}`)
          const off = vi.fn()
          disposers.push(off)
          return off
        },
      },
    }
  }

  it('registers once on the badge slot and unregisters on teardown', () => {
    const { store } = fakeStore(decisions(1))
    const s = slots()
    const off = registerCollapsedBadge(s.slots, store)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({ name: 'sidebar.toggle.badge', id: 'status-board' })
    off()
    expect(s.disposers[0]).toHaveBeenCalledTimes(1)
  })

  it('falls back to a lower priority when the shared one is taken', () => {
    const { store } = fakeStore(decisions(1))
    const s = slots(new Set([0]))
    const warn = vi.fn()
    registerCollapsedBadge(s.slots, store, warn)
    expect(s.calls.map(c => c.priority)).toEqual([0, -1])
    expect(warn).not.toHaveBeenCalled()
  })

  it('degrades silently, with one warning, when every seat is taken', () => {
    const { store } = fakeStore(decisions(1))
    const s = slots(new Set([0, -1]))
    const warn = vi.fn()
    let off: () => void = () => {}
    expect(() => {
      off = registerCollapsedBadge(s.slots, store, warn)
    }).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('collapsed badge not installed')
    expect(() => off()).not.toThrow()
  })

  it('does not warn repeatedly while the config toggles', () => {
    const ctl = fakeStore(decisions(1))
    const s = slots(new Set([0, -1]))
    const warn = vi.fn()
    registerCollapsedBadge(s.slots, ctl.store, warn)
    ctl.set({ showCollapsedBadge: false })
    ctl.set({ showCollapsedBadge: true })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not shadow the host occupant on the desktop shell', () => {
    ;(globalThis as Record<string, unknown>).dshDesktop = {}
    const { store } = fakeStore(decisions(1))
    const s = slots(new Set([0]))
    registerCollapsedBadge(s.slots, store, () => {})
    expect(s.calls.map(c => c.priority)).toEqual([0])
  })

  it('releases the seat when the option is switched off at runtime and retakes it when on', () => {
    const ctl = fakeStore(decisions(1))
    const s = slots()
    registerCollapsedBadge(s.slots, ctl.store)
    expect(s.calls).toHaveLength(1)
    ctl.set({ showCollapsedBadge: false })
    expect(s.disposers[0]).toHaveBeenCalledTimes(1)
    ctl.set({ showCollapsedBadge: true })
    expect(s.calls).toHaveLength(2)
  })

  it('registers nothing, and holds no store subscription, when disabled from the start', () => {
    const ctl = fakeStore(decisions(1), resolveConfig({ showCollapsedBadge: false }))
    const s = slots()
    const off = registerCollapsedBadge(s.slots, ctl.store)
    expect(s.calls).toHaveLength(0)
    off()
    expect(ctl.listeners.size).toBe(0)
  })

  it('leaves no store subscription behind after teardown', () => {
    const ctl = fakeStore(decisions(1))
    const off = registerCollapsedBadge(slots().slots, ctl.store)
    expect(ctl.listeners.size).toBe(1)
    off()
    expect(ctl.listeners.size).toBe(0)
  })
})
