/**
 * The Client half's state container.
 *
 * It is a small external store (`getSnapshot` + `subscribe`) so the view can
 * use `useSyncExternalStore` and re-render only when something actually
 * changed. Three inputs feed it:
 *
 * - the Harness session list (subscribed, the only live input),
 * - the Host-published configuration (fetched once, then fixed for the page),
 * - the user's collapse choices (persisted in `localStorage`).
 *
 * The store owns no polling: the Harness already publishes the session list, so
 * the board re-derives on each legitimate snapshot change. (The view refreshes
 * its relative timestamps locally; see `Panel.tsx`.)
 * @module dsh-plugin-status-board/client/store
 */

import { applyBoardFilter, buildBoard, isFilterActive, resolveCollapse, toggleCollapse } from '../shared/board.ts'
import { isCollapseMode, isPanelDensity, resolveConfig } from '../shared/config.ts'
import { STATUS_BOARD_CONFIG_MARKER, STATUS_BOARD_CONFIG_PATH } from '../shared/route.ts'
import { pickLocale, type LocaleId } from '../shared/i18n.ts'
import {
  BUCKET_IDS,
  type BoardEntry,
  type BoardFilterState,
  type BoardSnapshot,
  type BucketId,
  type CollapseState,
  type ResolvedStatusBoardConfig,
  type SessionSignal,
  type StatusBoardConfig,
  type WorkspaceScope,
} from '../shared/types.ts'
import {
  collectSessionSignals,
  resolveActiveWorkspaceId,
  type SessionsFace,
  type SessionListLike,
  type WorkspaceListLike,
} from './session-source.ts'

/**
 * The minimal storage face the store needs (browser `localStorage` subset).
 *
 * `removeItem` is part of it because forgetting a preference means deleting its
 * key, not writing back a default: a stored default is indistinguishable from a
 * choice the user made, so the control that offers the reset could never disable
 * itself again.
 */
export interface CollapseStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Locale service face (mirrored structurally). */
export interface LocaleFace {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

/** Loading state of the board's data. */
export type BoardStatus = 'loading' | 'ready' | 'error'

/** One immutable view state. */
export interface BoardState {
  /**
   * The boards, built from EVERY session. The floating button, the collapsed
   * badge and the sidebar tree read this one: they are the global sentinel and
   * must not be silenced by a view filter.
   */
  readonly board: BoardSnapshot
  /** The same boards after the floating panel's filter; identical to `board` when no filter applies. */
  readonly panelBoard: BoardSnapshot
  /** The panel filter in force. */
  readonly filter: BoardFilterState
  /** Workspace on screen, when the host's data names one. */
  readonly activeWorkspaceId: string | undefined
  /** Which boards are collapsed right now. */
  readonly collapse: CollapseState
  /** Configuration in force (Host-published, or defaults). */
  readonly config: ResolvedStatusBoardConfig
  /**
   * `'loading'` while the Harness is still enumerating sessions, `'error'` when
   * the profile exposes no session list at all, otherwise `'ready'`.
   */
  readonly status: BoardStatus
  /** Active locale id, resolved from the Harness locale service. */
  readonly locale: LocaleId
}

/** The store's public surface. */
export interface BoardStore {
  getSnapshot(): BoardState
  subscribe(listener: () => void): () => void
  /** Flip one board, persisting the choice. */
  toggle(id: BucketId): void
  /** Change the panel filter; only the workspace scope is persisted. */
  setFilter(patch: Partial<BoardFilterState>): void
  /**
   * Attach the Harness workspace service (it may mount after this plugin).
   * Returns the detach function; `undefined` detaches without a replacement.
   */
  attachWorkspaces(face: WorkspacesFace | undefined): () => void
  /** Stop every subscription (plugin unload / HMR). */
  dispose(): void
}

/** The workspace service face the store reads (`ctx.workspaces`). */
export interface WorkspacesFace {
  readonly list: {
    getSnapshot(): WorkspaceListLike
    subscribe(listener: () => void): () => void
  }
}

/** Persistence key; versioned so a future shape change can ignore old data. */
export const COLLAPSE_STORAGE_KEY = 'dsh-plugin-status-board.collapse.v1'

/** Persistence key of the panel's workspace scope. */
export const FILTER_STORAGE_KEY = 'dsh-plugin-status-board.filter.v1'

/** Interval of the decision-wait refresh while a decision is pending. */
export const SLA_TICK_MS = 30_000

/** Inputs the Client half hands the store. */
export interface BoardStoreOptions {
  /** The Harness `sessions` service, when the profile provides one. */
  readonly sessions?: SessionsFace | undefined
  /** The Harness locale service, when the profile provides one. */
  readonly locale?: LocaleFace | undefined
  /** Browser storage; `undefined` disables persistence. */
  readonly storage?: CollapseStorage | undefined
  /** The Harness workspace service, when already available. */
  readonly workspaces?: WorkspacesFace | undefined
  /** Clock injection point (tests). */
  readonly now?: (() => number) | undefined
  /**
   * Configuration source. Defaults to fetching {@link STATUS_BOARD_CONFIG_PATH};
   * tests replace it with a synchronous value.
   */
  readonly loadConfig?: (() => Promise<ResolvedStatusBoardConfig | undefined>) | undefined
}

/**
 * Read a persisted collapse state.
 *
 * The three classic boards must all be present as booleans; anything else
 * (corrupted JSON, a partial record) falls back to `undefined` so the configured
 * default applies. `automated` arrived later, so an older record without it is
 * still valid: the missing key takes `fallbackAutomated`.
 */
export function parseCollapse(raw: string | null, fallbackAutomated = false): CollapseState | undefined {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const state: Partial<Record<BucketId, boolean>> = {}
  for (const id of BUCKET_IDS) {
    const value = record[id]
    if (id === 'automated' && value === undefined) {
      state[id] = fallbackAutomated
      continue
    }
    if (typeof value !== 'boolean') return undefined
    state[id] = value
  }
  return {
    decision: state.decision ?? false,
    executing: state.executing ?? false,
    automated: state.automated ?? fallbackAutomated,
    recent: state.recent ?? false,
  }
}

/** Serialize a collapse state for persistence. */
export function serializeCollapse(state: CollapseState): string {
  return JSON.stringify({
    decision: state.decision,
    executing: state.executing,
    automated: state.automated,
    recent: state.recent,
  })
}

/** The filter a fresh page starts with. */
export const DEFAULT_FILTER: BoardFilterState = { workspaceScope: 'all', keyword: '' }

/** Read the persisted workspace scope; anything unreadable means `'all'`. */
export function parseWorkspaceScope(raw: string | null): WorkspaceScope {
  if (raw === null) return 'all'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).workspaceScope === 'current') {
      return 'current'
    }
  } catch {
    // Corrupt JSON: fall through to the default.
  }
  return 'all'
}

/**
 * Narrow an untrusted JSON value into a `StatusBoardConfig`.
 *
 * The Host is not an adversarial party, but it can be an *older or newer*
 * build, and a proxy can answer in its place. Unknown keys are dropped and
 * wrong-typed values are omitted, so `resolveConfig` then applies its own
 * defaults and bounds instead of receiving `as never` nonsense.
 */
export function toStatusBoardConfig(value: unknown): StatusBoardConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const config: {
    recentWindowHours?: number
    maxRecent?: number
    defaultCollapsed?: StatusBoardConfig['defaultCollapsed']
    showEmptyBuckets?: boolean
    showCollapsedBadge?: boolean
    decisionWarnMinutes?: number
    decisionCriticalMinutes?: number
    separateAutomatedSessions?: boolean
    panelDensity?: StatusBoardConfig['panelDensity']
  } = {}
  if (typeof record.recentWindowHours === 'number') config.recentWindowHours = record.recentWindowHours
  if (typeof record.maxRecent === 'number') config.maxRecent = record.maxRecent
  // Validate the enum here instead of casting: an unknown string would
  // otherwise be pushed into `resolveConfig` and silently replaced there,
  // which hides the disagreement between Host and Client versions.
  if (isCollapseMode(record.defaultCollapsed)) config.defaultCollapsed = record.defaultCollapsed
  if (typeof record.showEmptyBuckets === 'boolean') config.showEmptyBuckets = record.showEmptyBuckets
  if (typeof record.showCollapsedBadge === 'boolean') config.showCollapsedBadge = record.showCollapsedBadge
  if (typeof record.decisionWarnMinutes === 'number') config.decisionWarnMinutes = record.decisionWarnMinutes
  if (typeof record.decisionCriticalMinutes === 'number') config.decisionCriticalMinutes = record.decisionCriticalMinutes
  if (typeof record.separateAutomatedSessions === 'boolean') {
    config.separateAutomatedSessions = record.separateAutomatedSessions
  }
  if (isPanelDensity(record.panelDensity)) config.panelDensity = record.panelDensity
  return config
}

/**
 * Fetch the Host-published configuration.
 *
 * Every failure path is a fallback, never an exception: the panel must render on
 * a deployment whose Host half is absent (installed but disabled), on a
 * non-browser host, or while the web server is still starting.
 *
 * @param fetchImpl - the browser `fetch`.
 * @param timeoutMs - bound on the request so a hung server cannot block paint.
 */
export async function loadPublishedConfig(
  fetchImpl: typeof fetch | undefined,
  timeoutMs = 1_500,
): Promise<ResolvedStatusBoardConfig | undefined> {
  // A missing `fetch` is not an error worth surfacing: the board simply keeps
  // its documented defaults.
  if (typeof fetchImpl !== 'function') return undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(STATUS_BOARD_CONFIG_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as { marker?: unknown; config?: unknown }
    if (payload.marker !== STATUS_BOARD_CONFIG_MARKER) return undefined
    return resolveConfig(toStatusBoardConfig(payload.config))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the initial collapse state: a stored user choice wins, otherwise the
 * configured default applies.
 */
function initialState(config: ResolvedStatusBoardConfig, storage: CollapseStorage | undefined): CollapseState {
  const fallback = resolveCollapse(config.defaultCollapsed)
  return readStoredCollapse(storage, fallback.automated) ?? fallback
}

/** Read the persisted collapse state, tolerating unavailable or throwing storage. */
function readStoredCollapse(storage: CollapseStorage | undefined, fallbackAutomated = false): CollapseState | undefined {
  if (storage === undefined) return undefined
  try {
    return parseCollapse(storage.getItem(COLLAPSE_STORAGE_KEY), fallbackAutomated)
  } catch {
    return undefined
  }
}

/**
 * Create the store.
 *
 * @param options - the services and seams the store may use.
 * @returns a store the view can subscribe to.
 */
export function createBoardStore(options: BoardStoreOptions): BoardStore {
  const listeners = new Set<() => void>()
  const now = options.now ?? (() => Date.now())
  const storage = options.storage

  let config: ResolvedStatusBoardConfig = resolveConfig(undefined)
  let collapse: CollapseState = initialState(config, storage)
  /** True once the user has expressed a preference this page load. */
  let userTouched = readStoredCollapse(storage) !== undefined
  let filter: BoardFilterState = { workspaceScope: readStoredScope(storage), keyword: '' }
  let workspaces: WorkspacesFace | undefined = options.workspaces
  let workspaceOff: (() => void) | undefined
  let disposed = false
  /**
   * First time each session was seen waiting on the user, for snapshots that do
   * not carry the ask time. A session leaving `decision` drops its key at once
   * (see `compute`), so a later question starts a fresh clock.
   */
  const decisionEnteredAtMap = new Map<string, number>()
  let ticker: ReturnType<typeof setInterval> | undefined
  let state: BoardState = compute()

  const disposers: Array<() => void> = []

  /** Stamp decision sessions that have no native ask time, and forget the rest. */
  function withDecisionClock(signals: readonly SessionSignal[], at: number): SessionSignal[] {
    const waiting = new Set<string>()
    const stamped = signals.map(signal => {
      if (!signal.awaitingDecision) return signal
      waiting.add(signal.id)
      if (signal.askedAtMs !== undefined) return signal
      let entered = decisionEnteredAtMap.get(signal.id)
      if (entered === undefined) {
        entered = at
        decisionEnteredAtMap.set(signal.id, entered)
      }
      return { ...signal, askedAtMs: entered }
    })
    for (const id of [...decisionEnteredAtMap.keys()]) {
      if (!waiting.has(id)) decisionEnteredAtMap.delete(id)
    }
    return stamped
  }

  /** Build the current state from every input. */
  function compute(): BoardState {
    const list = options.sessions?.list?.getSnapshot()
    const workspaceSnapshot = workspaces?.list.getSnapshot()
    const at = now()
    const signals = withDecisionClock(collectSessionSignals(list, { workspaces: workspaceSnapshot }), at)
    const activeWorkspaceId = resolveActiveWorkspaceId(list, workspaceSnapshot)
    const board = buildBoard(signals, config, at)
    const panelBoard = isFilterActive(filter, activeWorkspaceId)
      ? buildBoard(applyBoardFilter(signals, filter, activeWorkspaceId), config, at)
      : board
    return {
      board,
      panelBoard,
      filter,
      activeWorkspaceId,
      collapse,
      config,
      status: statusOf(list),
      locale: pickLocale(options.locale?.getSnapshot().active),
    }
  }

  /** Derive the data state from the session-list phase. */
  function statusOf(list: SessionListLike | undefined): BoardStatus {
    if (options.sessions?.list === undefined || list === undefined) return 'error'
    return list.phase === 'pending' ? 'loading' : 'ready'
  }

  /** Whether the page is hidden; a server render or test has no document and counts as visible. */
  function pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  /** Run the wait-time ticker only while a decision is pending and the page is visible. */
  function syncTicker(): void {
    const wanted = !disposed && state.board.counts.decision > 0 && !pageHidden()
    if (wanted && ticker === undefined) {
      ticker = setInterval(() => recompute(), SLA_TICK_MS)
    } else if (!wanted && ticker !== undefined) {
      clearInterval(ticker)
      ticker = undefined
    }
  }

  /** Rebuild the immutable state and notify subscribers when it changed. */
  function recompute(): void {
    if (disposed) return
    const next = compute()
    if (!sameState(state, next)) {
      state = next
      for (const listener of listeners) listener()
    }
    syncTicker()
  }

  // Live input: the Harness session list.
  const sessionList = options.sessions?.list
  if (sessionList !== undefined) {
    disposers.push(sessionList.subscribe(() => recompute()))
  }

  // Locale changes only affect copy, not the board, but the view must re-render.
  if (options.locale !== undefined) {
    disposers.push(options.locale.subscribe(() => recompute()))
  }

  /** Subscribe to the workspace service currently attached, if any. */
  function bindWorkspaces(): void {
    workspaceOff?.()
    workspaceOff = workspaces?.list.subscribe(() => recompute())
  }
  bindWorkspaces()
  disposers.push(() => {
    workspaceOff?.()
    workspaceOff = undefined
  })

  // Coming back to the tab refreshes the wait times immediately; hiding it stops
  // the ticker, so a background tab does no work.
  if (typeof document !== 'undefined') {
    const onVisibility = (): void => recompute()
    document.addEventListener('visibilitychange', onVisibility)
    disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }
  disposers.push(() => {
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
  })

  // Configuration arrives asynchronously; the board renders with defaults until
  // it lands, which keeps the first paint instant.
  const loadConfig = options.loadConfig ?? (() => loadPublishedConfig(globalThis.fetch))

  /** Fetch the configuration once and fold it into the state. */
  function syncConfig(): void {
    loadConfig()
      .then(published => {
        if (disposed || published === undefined) return
        config = published
        // Adopt the newly published default ONLY while the user has expressed no
        // preference; otherwise their clicks would be silently reverted when the
        // config lands a moment later.
        if (!userTouched) collapse = resolveCollapse(published.defaultCollapsed)
        recompute()
      })
      .catch(() => {
        // A failed configuration load is not a rendering failure: the documented
        // defaults stay in force.
      })
  }

  syncConfig()
  syncTicker()

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    toggle(id) {
      if (disposed) return
      // Any toggle is a user preference from now on: a later configuration
      // publication must not overwrite it.
      userTouched = true
      collapse = toggleCollapse(collapse, id)
      if (storage !== undefined) {
        try {
          storage.setItem(COLLAPSE_STORAGE_KEY, serializeCollapse(collapse))
        } catch {
          // Storage may be full or blocked (private mode); the in-memory choice
          // still applies for this page.
        }
      }
      recompute()
    },
    setFilter(patch) {
      if (disposed) return
      const next: BoardFilterState = {
        workspaceScope: patch.workspaceScope ?? filter.workspaceScope,
        keyword: patch.keyword ?? filter.keyword,
      }
      if (next.workspaceScope === filter.workspaceScope && next.keyword === filter.keyword) return
      const scopeChanged = next.workspaceScope !== filter.workspaceScope
      filter = next
      // Only the scope is a device preference; the keyword lives for this page.
      if (scopeChanged && storage !== undefined) {
        try {
          storage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ workspaceScope: next.workspaceScope }))
        } catch {
          // Keep the in-memory choice.
        }
      }
      recompute()
    },
    attachWorkspaces(face) {
      if (disposed) return () => {}
      workspaces = face
      bindWorkspaces()
      recompute()
      return () => {
        if (workspaces !== face) return
        workspaces = undefined
        bindWorkspaces()
        recompute()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      for (const disposer of disposers) disposer()
      disposers.length = 0
      decisionEnteredAtMap.clear()
    },
  }
}

/** Read the persisted workspace scope, tolerating unavailable or throwing storage. */
function readStoredScope(storage: CollapseStorage | undefined): WorkspaceScope {
  if (storage === undefined) return 'all'
  try {
    return parseWorkspaceScope(storage.getItem(FILTER_STORAGE_KEY))
  } catch {
    return 'all'
  }
}

/**
 * Cheap structural comparison so an identical recompute does not re-render.
 *
 * Deliberately thorough: an earlier version short-circuited on the build
 * timestamp (so two publications in the same millisecond compared equal and the
 * change was dropped) and compared rows by id/title only (so a row's activity
 * timestamp — which drives the relative-time text — never triggered a repaint).
 */
function sameState(left: BoardState, right: BoardState): boolean {
  if (left.status !== right.status || left.locale !== right.locale) return false
  if (left.config !== right.config) return false
  if (left.filter.workspaceScope !== right.filter.workspaceScope || left.filter.keyword !== right.filter.keyword) return false
  if (left.activeWorkspaceId !== right.activeWorkspaceId) return false
  for (const id of BUCKET_IDS) {
    if (left.collapse[id] !== right.collapse[id]) return false
  }
  if (!sameBoard(left.board, right.board)) return false
  // `panelBoard` is the same object as `board` whenever no filter applies.
  return (
    (left.panelBoard === left.board) === (right.panelBoard === right.board) &&
    (right.panelBoard === right.board || sameBoard(left.panelBoard, right.panelBoard))
  )
}

/** One row's comparable shape: waiting time is compared by whole minute, which is what the UI shows. */
function rowKey(entry: BoardEntry): string {
  return JSON.stringify({
    ...entry,
    waitingMs: entry.waitingMs === undefined ? undefined : Math.floor(entry.waitingMs / 60_000),
  })
}

/** Structural comparison of two board snapshots. */
function sameBoard(left: BoardSnapshot, right: BoardSnapshot): boolean {
  if (left.buckets.length !== right.buckets.length) return false
  for (const id of ['decision', 'executing', 'recent', 'automated'] as const) {
    if (left.counts[id] !== right.counts[id]) return false
  }
  for (let index = 0; index < left.buckets.length; index += 1) {
    const leftBoard = left.buckets[index]
    const rightBoard = right.buckets[index]
    if (leftBoard === undefined || rightBoard === undefined) return false
    if (leftBoard.id !== rightBoard.id || leftBoard.truncated !== rightBoard.truncated) return false
    if (leftBoard.entries.length !== rightBoard.entries.length) return false
    for (let row = 0; row < leftBoard.entries.length; row += 1) {
      const a = leftBoard.entries[row]
      const b = rightBoard.entries[row]
      if (a === undefined || b === undefined) return false
      // Rows are small, and every field of a row is something the UI paints. A
      // structural compare keeps a changed option list, a new subagent count or a
      // severity change from being dropped as "same row".
      if (rowKey(a) !== rowKey(b)) return false
    }
  }
  return true
}
