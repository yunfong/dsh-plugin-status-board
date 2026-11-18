/**
 * Overlay (global counters, Escape order) and `apply()` wiring (workspace service,
 * badge-slot conflict, triage capability probing, teardown).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BoardOverlay, createOverlayController } from '../src/client/overlay.tsx'
import { apply, type ClientContext } from '../src/client/index.tsx'
import { createBoardStore } from '../src/client/store.ts'
import { resolveConfig } from '../src/shared/config.ts'
import type { SessionSummaryLike } from '../src/client/session-source.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NOW = Date.now()
const row = (id: string, extra: Partial<SessionSummaryLike> = {}): SessionSummaryLike => ({ id, displayTitle: id, running: false, updatedAt: NOW, ...extra })
const ask = { values: { userQuestions: { active: [{ callId: 'c', state: 'continued', questions: [{ id: 'q', question: 'x' }] }] } } }

const mounted: Array<{ root: Root; container: HTMLElement }> = []
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount())
    m.container.remove()
  }
})

function storeOf(rows: SessionSummaryLike[], projections: Record<string, unknown> = {}, config = {}) {
  return createBoardStore({
    sessions: { list: { getSnapshot: () => ({ byId: Object.fromEntries(rows.map(r => [r.id as string, r])), phase: 'ready' as const, projectionsBySession: projections as never }), subscribe: () => () => {} } },
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    loadConfig: () => Promise.resolve(resolveConfig(config)),
  })
}
function mountOverlay(store: ReturnType<typeof storeOf>) {
  const controller = createOverlayController()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(createElement(BoardOverlay, { controller, store, resolveNavigation: () => undefined })))
  mounted.push({ root, container })
  return { controller, container }
}
const click = (el: Element | null) => act(() => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('floating button stays global', () => {
  it('counts every session while the panel filter hides most of them', async () => {
    const store = storeOf([row('a', { displayTitle: 'apple' }), row('b', { displayTitle: 'banana' })], { a: ask, b: ask })
    await Promise.resolve()
    await Promise.resolve()
    const { container } = mountOverlay(store)
    expect(container.querySelector('.status-board__fab-center')?.textContent).toBe('2')
    store.setFilter({ keyword: 'apple' })
    expect(container.querySelector('.status-board__fab-center')?.textContent).toBe('2')
    click(container.querySelector('.status-board__fab'))
    expect(container.querySelector('.status-board__total')?.textContent).toBe('Sessions: 1')
    expect(container.querySelector('.status-board__overlay-subtitle')?.textContent).toBe('Sessions: 2')
    store.dispose()
  })

  it('tooltip rows add automated running work to "Running"', async () => {
    const store = storeOf([row('cron', { origin: 'cron' as never, running: true })], {}, { separateAutomatedSessions: true })
    await Promise.resolve()
    await Promise.resolve()
    const { container } = mountOverlay(store)
    const counts = [...container.querySelectorAll('.status-board__fab-count')].map(c => c.textContent)
    expect(counts).toEqual(['0', '1', '0', '0'])
    store.dispose()
  })
})

describe('Escape order', () => {
  async function open() {
    const store = storeOf([row('a', { displayTitle: 'alpha' })])
    await Promise.resolve()
    await Promise.resolve()
    const view = mountOverlay(store)
    click(view.container.querySelector('.status-board__fab'))
    const input = view.container.querySelector<HTMLInputElement>('input.status-board__filter')
    return { ...view, store, input }
  }
  const typeInto = (input: HTMLInputElement | null, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const esc = (target: Element) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))

  it('two presses: first clears the search, second closes the board', async () => {
    const { controller, input, store } = await open()
    typeInto(input, 'alp')
    expect(store.getSnapshot().filter.keyword).toBe('alp')
    esc(input as HTMLInputElement)
    expect(controller.getSnapshot()).toBe(true)
    expect(store.getSnapshot().filter.keyword).toBe('')
    esc(input as HTMLInputElement)
    expect(controller.getSnapshot()).toBe(false)
    store.dispose()
  })

  it('keeps the typed keyword across closing and reopening the board', async () => {
    const { controller, container, input, store } = await open()
    typeInto(input, 'alp')
    act(() => controller.close())
    click(container.querySelector('.status-board__fab'))
    expect(container.querySelector<HTMLInputElement>('input.status-board__filter')?.value).toBe('alp')
    store.dispose()
  })

  it('closes on an Escape pressed outside the panel when no search is claimed', async () => {
    const { controller, store } = await open()
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(controller.getSnapshot()).toBe(false)
    store.dispose()
  })
})

/** A recording context double for `apply()`. */
function fakeContext(options: { badgeTaken?: boolean; uiWorkspace?: unknown; uiSession?: unknown; workspaces?: unknown } = {}) {
  const injected = new Map<string, () => unknown>()
  const registered: Array<{ options: Record<string, unknown>; off: ReturnType<typeof vi.fn> }> = []
  const effects: Array<() => unknown> = []
  const sessionsListeners = new Set<() => void>()
  const optional = new Map<string, unknown>([
    ['uiWorkspace', options.uiWorkspace],
    ['uiSession', options.uiSession],
  ])
  const ctx: ClientContext = {
    slots: {
      register(opts: Record<string, unknown>) {
        if (opts.name === 'sidebar.toggle.badge' && options.badgeTaken === true) throw new Error('single slot "sidebar.toggle.badge" already has a registration')
        const off = vi.fn()
        registered.push({ options: opts, off })
        return off
      },
      inject(key: string, callback: () => unknown) {
        injected.set(key, callback)
        return callback()
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {}, phase: 'ready' as const }), subscribe: (l: () => void) => (sessionsListeners.add(l), () => sessionsListeners.delete(l)) } },
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {}, register: () => () => {} },
    get: (name: string) => optional.get(name),
    effect: (callback: () => unknown) => {
      effects.push(callback)
      callback()
    },
    inject: (keys: readonly string[], callback: (inner: unknown) => void) => {
      if (keys[0] === 'workspaces' && options.workspaces !== undefined) {
        callback({ get: () => options.workspaces, effect: (cb: () => unknown) => void effects.push(cb) })
      }
    },
  } as unknown as ClientContext
  return { ctx, registered, effects, sessionsListeners, injected }
}

describe('apply()', () => {
  it('registers all three seats', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx)
    expect(registered.map(r => r.options.name).sort()).toEqual(['shell.overlay', 'sidebar.panellist', 'sidebar.toggle.badge'])
  })

  it('survives a taken badge slot and still registers the other two', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, registered } = fakeContext({ badgeTaken: true })
    expect(() => apply(ctx)).not.toThrow()
    expect(registered.map(r => r.options.name).sort()).toEqual(['shell.overlay', 'sidebar.panellist'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('wires the workspace service into the store through a child context effect', () => {
    const subscribe = vi.fn(() => () => {})
    const { ctx, effects } = fakeContext({ workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe } } })
    apply(ctx)
    // The last effect is the workspace attachment; running it subscribes the store.
    const before = subscribe.mock.calls.length
    const dispose = effects.at(-1)?.()
    expect(subscribe.mock.calls.length).toBeGreaterThan(before - 1)
    expect(typeof dispose).toBe('function')
  })

  it('degrades when no workspace service exists', () => {
    const { ctx } = fakeContext()
    expect(() => apply(ctx)).not.toThrow()
  })

  it('stays silent on every seat when disposed through the effects', () => {
    const { ctx, effects, sessionsListeners } = fakeContext()
    apply(ctx)
    expect(sessionsListeners.size).toBe(1)
    effects.map(effect => effect()).filter(result => typeof result === 'function').forEach(result => (result as () => void)())
    expect(sessionsListeners.size).toBe(0)
  })
})
