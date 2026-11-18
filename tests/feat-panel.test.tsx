/**
 * Panel behaviour for v0.6 – v0.8: filter UI and keyboard, structured question
 * cards, batch triage, SLA badges and density.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BoardPanel, Row } from '../src/client/Panel.tsx'
import { StatusTree } from '../src/client/Tree.tsx'
import { UnreadStatusContext } from '../src/client/completion-unread.ts'
import { createBoardStore } from '../src/client/store.ts'
import type { BoardStore } from '../src/client/store.ts'
import { createTranslate } from '../src/shared/i18n.ts'
import { resolveConfig } from '../src/shared/config.ts'
import type { ActiveQuestion, BoardEntry, ResolvedStatusBoardConfig } from '../src/shared/types.ts'
import type { SessionListLike, SessionSummaryLike } from '../src/client/session-source.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NOW = Date.now()
const t = createTranslate('en')

const mounted: Array<{ root: Root; container: HTMLElement }> = []
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount())
    m.container.remove()
  }
})
function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(node))
  mounted.push({ root, container })
  return container
}
const $ = <T extends Element = HTMLElement>(c: ParentNode, sel: string) => c.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(c: ParentNode, sel: string) => Array.from(c.querySelectorAll<T>(sel))
const click = (el: Element | null | undefined) => act(() => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
function type(input: HTMLInputElement | null, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = (el: Element | null | undefined, init: KeyboardEventInit) =>
  act(() => void el?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))

const row = (id: string, extra: Partial<SessionSummaryLike> = {}): SessionSummaryLike => ({ id, displayTitle: id, running: false, updatedAt: NOW, ...extra })

function storeFor(
  rows: SessionSummaryLike[],
  config: Partial<ResolvedStatusBoardConfig> = {},
  projections: Record<string, unknown> = {},
  workspaces?: Parameters<typeof createBoardStore>[0]['workspaces'],
): BoardStore {
  const snapshot: SessionListLike = { byId: Object.fromEntries(rows.map(r => [r.id as string, r])), phase: 'ready', projectionsBySession: projections as never }
  return createBoardStore({
    sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } },
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    loadConfig: () => Promise.resolve(resolveConfig({ defaultCollapsed: 'none', ...config })),
    ...(workspaces === undefined ? {} : { workspaces }),
  })
}
async function ready(store: BoardStore): Promise<BoardStore> {
  await Promise.resolve()
  await Promise.resolve()
  return store
}

describe('filter UI', () => {
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [
          { workspaceId: 'w1', title: 'Alpha', path: '/a', sessionIds: ['a1', 'a2'] },
          { workspaceId: 'w2', title: 'Beta', path: '/b', sessionIds: ['b1'] },
        ],
      }),
      subscribe: () => () => {},
    },
  }
  const rows = [row('a1', { retainedBy: { mainView: 1 }, displayTitle: 'Fix parser' }), row('a2', { displayTitle: 'Docs' }), row('b1', { displayTitle: 'Parser perf' })]

  it('filters as you type with no debounce and shows the "Filtered" badge', async () => {
    const store = await ready(storeFor(rows, {}, {}, workspaces))
    const c = mount(createElement(BoardPanel, { store }))
    expect(c.textContent).not.toContain('Filtered')
    type($<HTMLInputElement>(c, 'input.status-board__filter'), 'parser')
    expect(c.textContent).toContain('Filtered')
    expect($$(c, '.status-board__row-title').map(e => e.textContent).sort()).toEqual(['Fix parser', 'Parser perf'])
    expect($(c, '.status-board__total')?.textContent).toBe('Sessions: 2')
  })

  it('matches the workspace name too', async () => {
    const store = await ready(storeFor(rows, {}, {}, workspaces))
    const c = mount(createElement(BoardPanel, { store }))
    type($<HTMLInputElement>(c, 'input.status-board__filter'), 'beta')
    expect($$(c, '.status-board__row-title').map(e => e.textContent)).toEqual(['Parser perf'])
  })

  it('switches to the current workspace and persists the choice', async () => {
    const store = await ready(storeFor(rows, {}, {}, workspaces))
    const c = mount(createElement(BoardPanel, { store }))
    const [, current] = $$<HTMLInputElement>(c, '.status-board__scope input')
    act(() => void current?.click())
    expect($$(c, '.status-board__row-title').map(e => e.textContent).sort()).toEqual(['Docs', 'Fix parser'])
    expect(store.getSnapshot().filter.workspaceScope).toBe('current')
  })

  it('disables the current-workspace option when no workspace is active', async () => {
    const store = await ready(storeFor([row('x')]))
    const c = mount(createElement(BoardPanel, { store }))
    const [all, current] = $$<HTMLInputElement>(c, '.status-board__scope input')
    expect(current?.disabled).toBe(true)
    expect(all?.checked).toBe(true)
    // and a stored "current" still shows everything
    store.setFilter({ workspaceScope: 'current' })
    expect(c.textContent).not.toContain('Filtered')
    expect(all?.checked).toBe(true)
  })

  it('shows an empty-state that clears the filter on click', async () => {
    const store = await ready(storeFor(rows, {}, {}, workspaces))
    const c = mount(createElement(BoardPanel, { store }))
    type($<HTMLInputElement>(c, 'input.status-board__filter'), 'zzzz')
    const clear = $(c, '.status-board__empty-clear')
    expect(clear?.textContent).toBe('No matching sessions. Click to clear the filter.')
    click(clear)
    expect($<HTMLInputElement>(c, 'input.status-board__filter')?.value).toBe('')
    expect($$(c, '.status-board__row-title')).toHaveLength(3)
  })

  it('keeps the global figures out of the filter: the store board is untouched', async () => {
    const store = await ready(storeFor(rows, {}, {}, workspaces))
    const c = mount(createElement(BoardPanel, { store }))
    type($<HTMLInputElement>(c, 'input.status-board__filter'), 'docs')
    expect(store.getSnapshot().board.counts.recent).toBe(3)
    expect(store.getSnapshot().panelBoard.counts.recent).toBe(1)
  })

  it('leaves the sidebar tree unfiltered and input-free', async () => {
    const store = await ready(storeFor(rows, {}, {}, workspaces))
    store.setFilter({ keyword: 'docs' })
    const c = mount(createElement(StatusTree, { store, onOpenSession: undefined }))
    expect(c.querySelector('input')).toBeNull()
    expect($$(c, '.status-board-tree__title')).toHaveLength(3)
  })
})

describe('filter keyboard', () => {
  async function panel() {
    const store = await ready(storeFor([row('a', { displayTitle: 'alpha' }), row('b', { displayTitle: 'beta' })]))
    const c = mount(createElement(BoardPanel, { store }))
    return { store, c, input: $<HTMLInputElement>(c, 'input.status-board__filter') }
  }

  it('"/" focuses the search box', async () => {
    const { c, input } = await panel()
    key($(c, '.status-board__title'), { key: '/' })
    expect(document.activeElement).toBe(input)
  })

  it('"/" typed inside the search box is just a character', async () => {
    const { input } = await panel()
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    act(() => void input?.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })

  it('Ctrl+F and Cmd+F focus the search box', async () => {
    const { c, input } = await panel()
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      input?.blur()
      key($(c, '.status-board__title'), { key: 'f', ...mod })
      expect(document.activeElement).toBe(input)
    }
  })

  it('Escape clears a non-empty search and claims the key so the board stays open', async () => {
    const { c, input, store } = await panel()
    type(input, 'alpha')
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void input?.dispatchEvent(event))
    expect(store.getSnapshot().filter.keyword).toBe('')
    expect(event.defaultPrevented).toBe(true)
    expect($<HTMLInputElement>(c, 'input.status-board__filter')?.value).toBe('')
  })

  it('Escape with an empty search is left alone for the overlay to close on', async () => {
    const { input } = await panel()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void input?.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('row badges and density', () => {
  const entry = (extra: Partial<BoardEntry> = {}): BoardEntry => ({ id: 'e', title: 'Task', lastActivityAt: NOW, ...extra })
  const render = (e: BoardEntry, bucket: 'decision' | 'executing' = 'executing', density?: 'compact' | 'comfortable') =>
    mount(createElement('ul', null, createElement(Row, { entry: e, bucket, translate: t, now: NOW, onOpen: () => {}, density })))

  it('shows "2 subagents running" and no row for the children', () => {
    const c = render(entry({ subagentStats: { total: 3, running: 2 } }))
    expect($(c, '.status-board__badge--subagent')?.textContent).toBe('2 subagents running')
  })

  it('shows no subagent badge when none are running', () => {
    const c = render(entry({ subagentStats: { total: 3, running: 0 } }))
    expect($(c, '.status-board__badge--subagent')).toBeNull()
  })

  it('shows the warning wait badge', () => {
    const c = render(entry({ severity: 'warning', waitingMs: 25 * 60_000 }), 'decision')
    const badge = $(c, '.status-board__badge--wait')
    expect(badge?.textContent).toBe('Waiting 25m')
    expect(badge?.getAttribute('data-severity')).toBe('warning')
  })

  it('shows the critical wait badge in hours and flags the row and the mark', () => {
    const c = render(entry({ severity: 'critical', waitingMs: 130 * 60_000 }), 'decision')
    expect($(c, '.status-board__badge--wait')?.textContent).toBe('Blocked 2h')
    expect($(c, '.status-board__row')?.getAttribute('data-severity')).toBe('critical')
    expect($(c, '.status-board-status')?.getAttribute('data-severity')).toBe('critical')
  })

  it('shows nothing for a normal or unknown wait', () => {
    expect($(render(entry({ severity: 'normal', waitingMs: 60_000 }), 'decision'), '.status-board__badge--wait')).toBeNull()
    expect($(render(entry({}), 'decision'), '.status-board__badge--wait')).toBeNull()
  })

  it('never shows a wait badge outside the decision board', () => {
    expect($(render(entry({ severity: 'critical', waitingMs: 999 * 60_000 }), 'executing'), '.status-board__badge--wait')).toBeNull()
  })

  it('names the wait in the row description for assistive technology', () => {
    const c = render(entry({ severity: 'critical', waitingMs: 130 * 60_000 }), 'decision')
    const ids = $(c, 'button.status-board__row')?.getAttribute('aria-describedby')?.split(' ') ?? []
    expect(ids).toHaveLength(2)
    expect(ids.every(id => document.getElementById(id) !== null)).toBe(true)
  })

  const preview = { snippet: 'Reading config', activeTool: 'read', tokenCount: 14_230 }
  it('shows the second line when comfortable', () => {
    const c = render(entry({ contextPreview: preview }), 'executing', 'comfortable')
    expect($(c, '.status-board__row-sub')?.textContent).toBe('Reading config · Running read · 14.2k tok')
  })
  it('hides the second line when compact', () => {
    expect($(render(entry({ contextPreview: preview }), 'executing', 'compact'), '.status-board__row-sub')).toBeNull()
  })
  it('renders the snippet as text, never as markup', () => {
    const c = render(entry({ contextPreview: { snippet: '<img src=x onerror=alert(1)>' } }))
    expect($(c, '.status-board__row-sub img')).toBeNull()
    expect($(c, '.status-board__row-sub')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('applies the configured density to the whole panel', async () => {
    const rows = [row('s', { running: true, lastMessageText: 'working on it' })]
    const comfortable = mount(createElement(BoardPanel, { store: await ready(storeFor(rows)) }))
    expect($(comfortable, '.status-board__row-sub')?.textContent).toBe('working on it')
    const compact = mount(createElement(BoardPanel, { store: await ready(storeFor(rows, { panelDensity: 'compact' })) }))
    expect($(compact, '.status-board__row-sub')).toBeNull()
  })

  it('keeps the sidebar tree on a single line with a number-only subagent badge', async () => {
    const store = await ready(storeFor([row('s', { running: true, lastMessageText: 'second line text' }), row('p'), row('k', { parentId: 's', origin: 'subagent', running: true })]))
    const c = mount(createElement(StatusTree, { store, onOpenSession: () => {} }))
    expect($(c, '.status-board-tree__subagents')?.textContent).toBe('1')
    expect(c.textContent).not.toContain('second line text')
    expect($(c, '.status-board__row-sub')).toBeNull()
    expect($$(c, '.status-board-tree__title').map(e => e.textContent).sort()).toEqual(['p', 's'])
  })
})

describe('automated board in the panel', () => {
  it('renders the board between "Completed unread" and "Recent" only when enabled', async () => {
    const rows = [row('c', { origin: 'cron' as never }), row('r')]
    const off = mount(createElement(BoardPanel, { store: await ready(storeFor(rows)) }))
    expect($(off, '[data-bucket="automated"]')).toBeNull()
    const on = mount(createElement(BoardPanel, { store: await ready(storeFor(rows, { separateAutomatedSessions: true })) }))
    const order = $$(on, 'section[data-bucket]').map(s => s.getAttribute('data-bucket'))
    expect(order).toEqual(['decision', 'executing', 'unread', 'automated', 'recent'])
    expect($(on, '[data-bucket="automated"]')?.textContent).toContain('c')
  })

  it('moves an automated session that asks a question into the decision board', async () => {
    const ask = { values: { userQuestions: { active: [{ callId: 'c', state: 'continued', questions: [{ id: 'q', question: 'ok?' }] }] } } }
    const store = await ready(storeFor([row('cron', { origin: 'cron' as never, running: true })], { separateAutomatedSessions: true }, { cron: ask }))
    const c = mount(createElement(BoardPanel, { store }))
    expect($(c, '[data-bucket="decision"]')?.textContent).toContain('cron')
    expect($(c, '[data-bucket="automated"]')?.textContent).not.toContain('cron')
  })

  it('shows it in the sidebar tree too', async () => {
    const store = await ready(storeFor([row('c', { origin: 'cron' as never })], { separateAutomatedSessions: true }))
    const c = mount(createElement(StatusTree, { store, onOpenSession: undefined }))
    expect($(c, '[data-bucket="automated"]')).not.toBeNull()
  })
})

describe('batch triage', () => {
  const finished = (n: number) => Array.from({ length: n }, (_, i) => row(`r${i}`, { displayTitle: `done ${i}`, updatedAt: NOW - i * 1000 }))
  const panel = async (rows: SessionSummaryLike[], actions: { archive?: (id: string) => Promise<void>; markRead?: (id: string) => Promise<void> }, statuses: Map<string, { completionUnread?: boolean }> = new Map()) => {
    const store = await ready(storeFor(rows))
    const c = mount(createElement(UnreadStatusContext.Provider, { value: statuses }, createElement(BoardPanel, { store, resolveTriage: () => actions })))
    return { store, c }
  }
  const buttonIn = (c: HTMLElement, bucket: string, text: RegExp) =>
    $$<HTMLButtonElement>(c, `[data-bucket="${bucket}"] .status-board__triage-button`).find(b => text.test(b.textContent ?? ''))
  const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)) })

  it('offers archive on "Recent" and never on the active boards', async () => {
    const running = row('run', { running: true })
    const ask = { values: { userQuestions: { active: [{ callId: 'c', state: 'open', questions: [{ id: 'q', question: 'x' }] }] } } }
    const store = await ready(storeFor([...finished(4), running, row('dec')], {}, { dec: ask }))
    const c = mount(createElement(BoardPanel, { store, resolveTriage: () => ({ archive: async () => {} }) }))
    expect($$(c, '[data-bucket="decision"] .status-board__triage-button')).toHaveLength(0)
    expect($$(c, '[data-bucket="executing"] .status-board__triage-button')).toHaveLength(0)
    expect($$(c, '[data-bucket="recent"] .status-board__triage-button')).toHaveLength(1)
  })

  it('hides every control when the host has no archive API, with no disabled stub', async () => {
    const { c } = await panel(finished(5), {})
    expect($$(c, '.status-board__triage-button')).toHaveLength(0)
    expect($(c, '.status-board__triage-actions')).toBeNull()
  })

  it('asks inline before archiving three or more, and never with window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const archive = vi.fn().mockResolvedValue(undefined)
    const { c } = await panel(finished(5), { archive })
    click(buttonIn(c, 'recent', /Archive all/))
    expect(archive).not.toHaveBeenCalled()
    expect($(c, '.status-board__triage-confirm')?.textContent).toContain('Archive 5 finished sessions in this board?')
    expect(confirm).not.toHaveBeenCalled()
    click($(c, '.status-board__triage-yes'))
    await flush()
    expect(archive).toHaveBeenCalledTimes(5)
    confirm.mockRestore()
  })

  it('cancel does nothing', async () => {
    const archive = vi.fn().mockResolvedValue(undefined)
    const { c } = await panel(finished(5), { archive })
    click(buttonIn(c, 'recent', /Archive all/))
    click($(c, '.status-board__triage-no'))
    expect($(c, '.status-board__triage-confirm')).toBeNull()
    await flush()
    expect(archive).not.toHaveBeenCalled()
  })

  it('archives one or two immediately, without a prompt', async () => {
    const archive = vi.fn().mockResolvedValue(undefined)
    const { c } = await panel(finished(2), { archive })
    click(buttonIn(c, 'recent', /Archive all/))
    await flush()
    expect(archive).toHaveBeenCalledTimes(2)
    expect($(c, '.status-board__triage-confirm')).toBeNull()
  })

  it('caps concurrency at 5 and finishes the rest after a failure', async () => {
    let active = 0
    let peak = 0
    const done: string[] = []
    const archive = vi.fn(async (id: string) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 4))
      active -= 1
      if (id === 'r2') throw new Error('session still running')
      done.push(id)
    })
    const { c } = await panel(finished(12), { archive })
    click(buttonIn(c, 'recent', /Archive all/))
    click($(c, '.status-board__triage-yes'))
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
    expect(peak).toBeLessThanOrEqual(5)
    expect(done).toHaveLength(11)
    expect($(c, '.status-board__triage-error')?.textContent).toBe('1 sessions could not be archived: session still running')
  })

  it('locks the button and shows progress while running', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const archive = vi.fn(() => gate)
    const { c } = await panel(finished(2), { archive })
    click(buttonIn(c, 'recent', /Archive all/))
    const busy = $$<HTMLButtonElement>(c, '[data-bucket="recent"] .status-board__triage-button')[0]
    expect(busy?.disabled).toBe(true)
    expect(busy?.textContent).toBe('Archiving 0/2…')
    click(busy)
    expect(archive).toHaveBeenCalledTimes(2)
    release()
    await flush()
    expect(buttonIn(c, 'recent', /Archive all/)?.disabled).toBe(false)
  })

  it('offers "mark all read" on the unread board only, and only when the host can', async () => {
    const statuses = new Map([['r0', { completionUnread: true }], ['r1', { completionUnread: true }]])
    const without = await panel(finished(3), { archive: async () => {} }, statuses)
    expect(buttonIn(without.c, 'unread', /Mark all read/)).toBeUndefined()
    expect(buttonIn(without.c, 'unread', /Archive all/)).toBeDefined()

    const markRead = vi.fn().mockResolvedValue(undefined)
    const withApi = await panel(finished(3), { markRead }, statuses)
    expect(buttonIn(withApi.c, 'unread', /Mark all read/)).toBeDefined()
    expect(buttonIn(withApi.c, 'recent', /Mark all read/)).toBeUndefined()
    click(buttonIn(withApi.c, 'unread', /Mark all read/))
    await flush()
    expect(markRead.mock.calls.map(call => call[0]).sort()).toEqual(['r0', 'r1'])
  })

  it('archives exactly the rows the board lists (unread rows are not in "Recent")', async () => {
    const archive = vi.fn().mockResolvedValue(undefined)
    const { c } = await panel(finished(4), { archive }, new Map([['r0', { completionUnread: true }]]))
    click(buttonIn(c, 'recent', /Archive all/))
    click($(c, '.status-board__triage-yes'))
    await flush()
    expect(archive.mock.calls.map(call => call[0]).sort()).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('structured question cards', () => {
  const call = (questions: ActiveQuestion['questions'], extra: Partial<ActiveQuestion> = {}): ActiveQuestion => ({ callId: 'call-1', state: 'continued', questions, ...extra })
  const entryWith = (c: ActiveQuestion): BoardEntry => ({ id: 'sess', title: 'Needs a call', lastActivityAt: NOW, questions: [c] })
  const renderCard = (c: ActiveQuestion, answerQuestion = vi.fn().mockResolvedValue(undefined), onOpen = vi.fn()) => {
    const container = mount(createElement('ul', null, createElement(Row, { entry: entryWith(c), bucket: 'decision', translate: t, now: NOW, onOpen, answerQuestion })))
    click($(container, '.status-board__answer-toggle'))
    return { container, answerQuestion, onOpen }
  }
  const submitBtn = (c: HTMLElement) => $<HTMLButtonElement>(c, '.status-board__q-submit')
  const flush = () => act(async () => { await Promise.resolve() })

  it('continued: a text box submits through the form', async () => {
    const { container, answerQuestion } = renderCard(call([{ id: 'q', question: 'Why?' }], { kind: 'continued' }))
    type($<HTMLInputElement>(container, '.status-board__q-input'), 'because')
    click(submitBtn(container))
    await flush()
    expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: [], custom: 'because' }] })
  })

  it('continued: submits empty (skip) as before', async () => {
    const { container, answerQuestion } = renderCard(call([{ id: 'q', question: 'Why?' }]))
    click(submitBtn(container))
    await flush()
    expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: [] }] })
  })

  describe('single_select', () => {
    const q = [{ id: 'q', question: 'Which?', header: 'Pick one', options: [{ label: 'A', description: 'first' }, { label: 'B' }] }]
    it('is a radio group wired to its legend, with described options', () => {
      const { container } = renderCard(call(q))
      const group = $(container, '[role="radiogroup"]')
      expect(group).not.toBeNull()
      expect(document.getElementById(group?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Pick one')
      const radios = $$<HTMLInputElement>(container, 'input[type="radio"].status-board__q-option-input')
      expect(radios.map(r => r.value)).toEqual(['A', 'B'])
      const describedBy = radios[0]?.getAttribute('aria-describedby') ?? ''
      expect(document.getElementById(describedBy)?.textContent).toBe('first')
      expect(new Set(radios.map(r => r.name)).size).toBe(1)
    })
    it('needs a choice before it can submit, and submits the label', async () => {
      const { container, answerQuestion } = renderCard(call(q))
      expect(submitBtn(container)?.disabled).toBe(true)
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[1]?.click())
      expect(submitBtn(container)?.disabled).toBe(false)
      click(submitBtn(container))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: ['B'] }] })
    })
    it('"other" supersedes the picked option', async () => {
      const { container, answerQuestion } = renderCard(call(q))
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[0]?.click())
      act(() => void $<HTMLInputElement>(container, '.status-board__q-option--other input')?.click())
      type($<HTMLInputElement>(container, '.status-board__q-input'), 'something else')
      click(submitBtn(container))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: [], custom: 'something else' }] })
    })
    it('a form submit (Enter) sends once the draft is complete', async () => {
      const { container, answerQuestion } = renderCard(call(q))
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[0]?.click())
      act(() => void $(container, 'form.status-board__qcall')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
      await flush()
      expect(answerQuestion).toHaveBeenCalledTimes(1)
    })
    it('Enter on an incomplete form sends nothing', async () => {
      const { container, answerQuestion } = renderCard(call(q))
      act(() => void $(container, 'form.status-board__qcall')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
      await flush()
      expect(answerQuestion).not.toHaveBeenCalled()
    })
  })

  describe('multi_select', () => {
    const q = [{ id: 'q', question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }]
    it('is a checkbox group that requires at least one', async () => {
      const { container, answerQuestion } = renderCard(call(q))
      expect($(container, '[role="group"][aria-labelledby]')).not.toBeNull()
      expect($$(container, 'input[type="checkbox"].status-board__q-option-input').length).toBeGreaterThanOrEqual(3)
      expect(submitBtn(container)?.disabled).toBe(true)
      expect(container.textContent).toContain('Pick at least one option')
      const boxes = $$<HTMLInputElement>(container, 'input[value]')
      act(() => void boxes[0]?.click())
      act(() => void boxes[2]?.click())
      click(submitBtn(container))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: ['A', 'C'] }] })
    })
    it('unchecking back to nothing disables submit again', () => {
      const { container } = renderCard(call(q))
      const a = $$<HTMLInputElement>(container, 'input[value]')[0]
      act(() => void a?.click())
      act(() => void a?.click())
      expect(submitBtn(container)?.disabled).toBe(true)
    })
    it('"other" text supplements the checked options', async () => {
      const { container, answerQuestion } = renderCard(call(q))
      act(() => void $$<HTMLInputElement>(container, 'input[value]')[1]?.click())
      act(() => void $<HTMLInputElement>(container, '.status-board__q-option--other input')?.click())
      type($<HTMLInputElement>(container, '.status-board__q-input'), 'extra')
      click(submitBtn(container))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: ['B'], custom: 'extra' }] })
    })
  })

  describe('confirm', () => {
    const q = [{ id: 'q', question: 'Approve this plan?', header: 'Plan review', detail: 'line one\nline two', options: [{ label: 'Go' }, { label: 'Nope' }], intent: { kind: 'plan-review' as const, approve: 'Go' } }]
    it('shows a collapsed preview with an expand control', () => {
      const { container } = renderCard(call(q, { kind: 'confirm', summaryPreview: 'line one\nline two' }))
      const preview = $(container, '.status-board__q-preview')
      expect(preview?.textContent).toBe('line one\nline two')
      expect(preview?.getAttribute('data-expanded')).toBe('false')
      const more = $<HTMLButtonElement>(container, '.status-board__q-more')
      expect(more?.getAttribute('aria-controls')).toBe(preview?.id)
      click(more)
      expect(preview?.getAttribute('data-expanded')).toBe('true')
      expect(more?.getAttribute('aria-expanded')).toBe('true')
    })
    it('never shows more than 500 characters of the plan', () => {
      const long = [{ ...q[0]!, detail: 'x'.repeat(3_000) }]
      const { container } = renderCard(call(long, { kind: 'confirm' }))
      expect(Array.from($(container, '.status-board__q-preview')?.textContent ?? '').length).toBeLessThanOrEqual(500)
    })
    it('approves with one press', async () => {
      const { container, answerQuestion } = renderCard(call(q, { kind: 'confirm' }))
      click($(container, '.status-board__q-submit'))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: ['Go'] }] })
    })
    it('rejects in two steps: reveal the note box, then send the decline with the note', async () => {
      const { container, answerQuestion } = renderCard(call(q, { kind: 'confirm' }))
      click($(container, '.status-board__q-reject'))
      expect(answerQuestion).not.toHaveBeenCalled()
      const note = $<HTMLInputElement>(container, '.status-board__q-input')
      expect(note).not.toBeNull()
      type(note, 'too risky')
      click($(container, '.status-board__q-reject'))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: ['Nope'], custom: 'too risky' }] })
    })
    it('a rejection without a note still sends the decline', async () => {
      const { container, answerQuestion } = renderCard(call(q, { kind: 'confirm' }))
      click($(container, '.status-board__q-reject'))
      click($(container, '.status-board__q-reject'))
      await flush()
      expect(answerQuestion).toHaveBeenCalledWith('sess', 'call-1', { answers: [{ id: 'q', selected: ['Nope'] }] })
    })
  })

  describe('complex_open', () => {
    it('shows a summary and a jump button, never a form', () => {
      const { container, onOpen, answerQuestion } = renderCard(call([{ id: 'a', question: 'First part' }, { id: 'b', question: 'Second' }], { kind: 'complex_open' }))
      expect($(container, 'form')).toBeNull()
      expect($(container, 'input')).toBeNull()
      expect(container.textContent).toContain('First part')
      click($(container, '.status-board__q-open--primary'))
      expect(onOpen).toHaveBeenCalledWith('sess')
      expect(answerQuestion).not.toHaveBeenCalled()
    })
    it('does not crash on an unknown schema without a kind', () => {
      const { container } = renderCard(call([{ id: 'a', question: 'x' }, { id: 'b', question: 'y' }]))
      expect($(container, '[data-kind="complex_open"]')).not.toBeNull()
    })
  })

  describe('submit lifecycle', () => {
    const q = [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]
    it('locks the whole card on submit so a double click sends once', async () => {
      let release: () => void = () => {}
      const answerQuestion = vi.fn(() => new Promise<void>(resolve => (release = resolve)))
      const { container } = renderCard(call(q), answerQuestion)
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[0]?.click())
      const button = submitBtn(container)
      click(button)
      click(button)
      click(button)
      expect(answerQuestion).toHaveBeenCalledTimes(1)
      expect($$<HTMLInputElement>(container, 'input').every(i => i.disabled)).toBe(true)
      expect(button?.textContent).toBe('Submitting…')
      release()
      await flush()
      expect(container.textContent).toContain('Submitted; waiting for the agent')
    })
    it('keeps the draft on failure, shows the reason and a jump to the session', async () => {
      const answerQuestion = vi.fn().mockRejectedValueOnce(new Error('host said no')).mockResolvedValue(undefined)
      const { container, onOpen } = renderCard(call(q), answerQuestion)
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[1]?.click())
      click(submitBtn(container))
      await flush()
      await flush()
      expect($(container, '[role="alert"]')?.textContent).toBe('Submit failed: host said no')
      expect($$<HTMLInputElement>(container, 'input[type="radio"]')[1]?.checked).toBe(true)
      expect(submitBtn(container)?.disabled).toBe(false)
      click($(container, '.status-board__q-retry'))
      expect(onOpen).toHaveBeenCalledWith('sess')
      click(submitBtn(container))
      await flush()
      expect(answerQuestion).toHaveBeenCalledTimes(2)
      expect(answerQuestion.mock.calls[1]?.[2]).toEqual({ answers: [{ id: 'q', selected: ['B'] }] })
    })
  })

  describe('answered elsewhere', () => {
    const q1 = [{ id: 'q', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] }]
    const q2 = [{ id: 'q', question: 'Second?', options: [{ label: 'A' }, { label: 'B' }] }]
    const wrap = (c: ActiveQuestion, answerQuestion: () => Promise<void>) =>
      createElement('ul', null, createElement(Row, { entry: entryWith(c), bucket: 'decision', translate: t, now: NOW, onOpen: () => {}, answerQuestion }))

    it('drops the old draft when a new question id arrives and never sends it to the new one', async () => {
      const answerQuestion = vi.fn().mockResolvedValue(undefined)
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      mounted.push({ root, container })
      act(() => root.render(wrap(call(q1, { callId: 'old' }), answerQuestion)))
      click($(container, '.status-board__answer-toggle'))
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[0]?.click())
      expect($$<HTMLInputElement>(container, 'input[type="radio"]')[0]?.checked).toBe(true)

      act(() => root.render(wrap(call(q2, { callId: 'new' }), answerQuestion)))
      expect($$<HTMLInputElement>(container, 'input[type="radio"]').every(r => !r.checked)).toBe(true)
      expect(container.textContent).toContain('Second?')
      expect(submitBtn(container)?.disabled).toBe(true)
      expect(container.textContent).toContain('The question changed; your draft was cleared')
      expect(answerQuestion).not.toHaveBeenCalled()
    })

    it('a fresh submitting state does not leak onto the new question', async () => {
      let release: () => void = () => {}
      const answerQuestion = vi.fn(() => new Promise<void>(resolve => (release = resolve)))
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      mounted.push({ root, container })
      act(() => root.render(wrap(call(q1, { callId: 'old' }), answerQuestion)))
      click($(container, '.status-board__answer-toggle'))
      act(() => void $$<HTMLInputElement>(container, 'input[type="radio"]')[0]?.click())
      click(submitBtn(container))
      act(() => root.render(wrap(call(q2, { callId: 'new' }), answerQuestion)))
      expect($$<HTMLInputElement>(container, 'input[type="radio"]').every(r => !r.disabled)).toBe(true)
      release()
      await flush()
    })

    it('collapses the card when the question disappears', () => {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      mounted.push({ root, container })
      act(() => root.render(wrap(call(q1), async () => {})))
      act(() => root.render(createElement('ul', null, createElement(Row, { entry: { id: 'sess', title: 'Needs a call', lastActivityAt: NOW }, bucket: 'executing', translate: t, now: NOW, onOpen: () => {} }))))
      expect($(container, '.status-board__qcard')).toBeNull()
      expect($(container, '.status-board__answer-toggle')).toBeNull()
    })
  })

  it('an open (still foreground) question stays read-only for every family', () => {
    const { container } = renderCard(call([{ id: 'q', question: 'x', options: [{ label: 'A' }] }], { state: 'open' }))
    expect($$<HTMLInputElement>(container, '.status-board__q-option-input').every(i => i.disabled)).toBe(true)
    expect($(container, '.status-board__q-submit')).toBeNull()
    expect(container.textContent).toContain('still waiting in the session')
  })

  it('without the answer channel, the card points at the session', () => {
    const container = mount(createElement('ul', null, createElement(Row, { entry: entryWith(call([{ id: 'q', question: 'x' }])), bucket: 'decision', translate: t, now: NOW, onOpen: () => {} })))
    click($(container, '.status-board__answer-toggle'))
    expect($(container, '.status-board__q-submit')).toBeNull()
    expect(container.textContent).toContain('Answering is unavailable here')
  })
})
