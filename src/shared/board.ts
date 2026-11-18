/**
 * The board's pure core: classification, ordering, capping and collapse state.
 *
 * Every function here is deterministic and free of I/O so the delivery
 * contract (which board a Session lands in, in what order, and how many rows
 * survive the cap) is covered by ordinary unit tests instead of a live Harness.
 * @module dsh-plugin-status-board/shared/board
 */

import {
  BUCKET_IDS,
  type BoardBucket,
  type BoardEntry,
  type BoardFilterState,
  type BoardSnapshot,
  type BucketId,
  type CollapseMode,
  type CollapseState,
  type CoreBucketId,
  type DecisionSeverity,
  type ResolvedStatusBoardConfig,
  type SessionSignal,
  type WorkspaceScope,
} from './types.ts'

/** Milliseconds in one hour; kept local so the arithmetic is self-documenting. */
const HOUR_MS = 3_600_000

/**
 * Clamp a configured number into an inclusive integer range.
 *
 * `buildBoard` is a public function and the Client's config can arrive from an
 * older Host build, so the bound is enforced here as well as in
 * `resolveConfig`; a caller that bypasses the resolver must not be able to
 * request an unbounded window.
 */
function clampToRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Classify one Session.
 *
 * Precedence is intentional and ordered:
 * 1. `awaitingDecision` wins outright — a Session that cannot proceed without
 *    the user is not "in progress" in any useful sense. This also holds for an
 *    automated Session that asked a question: it is on the user's desk now.
 * 2. an automated origin goes to `automated`, when that board is enabled, so a
 *    cron job running every minute cannot push human conversations out of view.
 * 3. `running` next — the Agent is doing work.
 * 4. everything else is a record.
 *
 * @param signal - the Session's reduced state.
 * @param separateAutomated - whether the `automated` board is enabled.
 * @returns the board it belongs to.
 */
export function classifySession(signal: SessionSignal, separateAutomated = false): BucketId {
  if (signal.awaitingDecision) return 'decision'
  if (separateAutomated && signal.isAutomatedOrigin === true) return 'automated'
  if (signal.running) return 'executing'
  return 'recent'
}

/** Minute thresholds the severity grading uses; see {@link CONFIG_LIMITS}. */
export interface SeverityThresholds {
  readonly warnMinutes: number
  readonly criticalMinutes: number
}

/**
 * Grade how long a decision has been blocking.
 *
 * Bounds are enforced here as well as in `resolveConfig`: `buildBoard` is public
 * and must not misbehave on a caller that skipped the resolver. The critical
 * threshold is lifted to the warning one, so a row cannot skip the warning tier.
 *
 * @param waitingMs - blocking time, or `undefined` when the ask time is unknown.
 */
export function decisionSeverity(
  waitingMs: number | undefined,
  thresholds: SeverityThresholds,
): DecisionSeverity {
  if (waitingMs === undefined || !Number.isFinite(waitingMs)) return 'normal'
  const warn = clampToRange(thresholds.warnMinutes, 1, 1440, 15)
  const critical = Math.max(clampToRange(thresholds.criticalMinutes, 5, 4320, 60), warn)
  const minutes = waitingMs / 60_000
  if (minutes >= critical) return 'critical'
  if (minutes >= warn) return 'warning'
  return 'normal'
}

/** Blocking time of a decision signal, or `undefined` when its ask time is unknown. */
export function waitingMsOf(signal: SessionSignal, now: number): number | undefined {
  const asked = signal.askedAtMs
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return undefined
  return Math.max(0, now - asked)
}

/**
 * Newest first, ties broken by id so the order is stable across snapshots
 * (two Sessions touched in the same millisecond must not swap places on every
 * render).
 */
export function compareByRecency(left: SessionSignal, right: SessionSignal): number {
  if (left.lastActivityAt !== right.lastActivityAt) {
    return right.lastActivityAt - left.lastActivityAt
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Whether a Session falls inside the "recent records" window.
 *
 * An unknown timestamp (`0`, or any non-finite value) is treated as recent:
 * hiding a Session because its timestamp is missing would be a silent data
 * loss for the user.
 */
export function isWithinWindow(signal: SessionSignal, now: number, windowHours: number): boolean {
  const stamp = signal.lastActivityAt
  if (!Number.isFinite(stamp) || stamp <= 0) return true
  return now - stamp <= windowHours * HOUR_MS
}

/** Reduce a signal to the row shape the view renders. */
function toEntry(signal: SessionSignal, decision?: { waitingMs: number | undefined; severity: DecisionSeverity }): BoardEntry {
  return {
    id: signal.id,
    title: signal.title,
    workspacePath: signal.workspacePath,
    ...(signal.workspaceId === undefined ? {} : { workspaceId: signal.workspaceId }),
    ...(signal.workspaceName === undefined ? {} : { workspaceName: signal.workspaceName }),
    lastActivityAt: signal.lastActivityAt,
    ...(signal.running ? { running: true } : {}),
    ...(signal.questions === undefined || signal.questions.length === 0 ? {} : { questions: signal.questions }),
    ...(decision === undefined
      ? {}
      : {
          ...(decision.waitingMs === undefined ? {} : { waitingMs: decision.waitingMs }),
          severity: decision.severity,
        }),
    ...(signal.subagentStats === undefined ? {} : { subagentStats: signal.subagentStats }),
    ...(signal.contextPreview === undefined ? {} : { contextPreview: signal.contextPreview }),
  }
}

/**
 * Decision order: critical rows first (longest blocked first), then everything
 * else by recency. The id tiebreak keeps the order stable across snapshots.
 */
export function compareDecisions(left: BoardEntry, right: BoardEntry): number {
  const leftCritical = left.severity === 'critical'
  const rightCritical = right.severity === 'critical'
  if (leftCritical !== rightCritical) return leftCritical ? -1 : 1
  if (leftCritical && rightCritical) {
    const byWait = (right.waitingMs ?? 0) - (left.waitingMs ?? 0)
    if (byWait !== 0) return byWait
  } else if (left.lastActivityAt !== right.lastActivityAt) {
    return right.lastActivityAt - left.lastActivityAt
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Build one board.
 *
 * @param id - which board.
 * @param entries - already ordered rows.
 * @param truncated - rows the cap hid.
 */
function bucket(id: BucketId, entries: readonly BoardEntry[], truncated = 0): BoardBucket {
  return { id, entries, truncated }
}

/** Configuration slice {@link buildBoard} reads; the SLA and automated fields are optional. */
export type BoardBuildConfig = Pick<ResolvedStatusBoardConfig, 'recentWindowHours' | 'maxRecent'> &
  Partial<Pick<ResolvedStatusBoardConfig, 'decisionWarnMinutes' | 'decisionCriticalMinutes' | 'separateAutomatedSessions'>>

/**
 * Turn Session signals into the boards.
 *
 * The three classic boards are always present; `automated` exists only when
 * `separateAutomatedSessions` is on, so an upgrade keeps the old shape by default.
 *
 * @param signals - every Session the caller can see.
 * @param config - resolved plugin configuration.
 * @param now - clock injection point (epoch ms); defaults to `Date.now()`.
 * @returns a snapshot whose classic boards are always present.
 */
export function buildBoard(
  signals: readonly SessionSignal[],
  config: BoardBuildConfig,
  now: number = Date.now(),
): BoardSnapshot {
  const separate = config.separateAutomatedSessions === true
  // A total, pre-seeded record: a Map lookup that missed would silently drop a
  // session from every board, which is worse than the type noise a `!` avoids.
  const buckets: Record<BucketId, SessionSignal[]> = { decision: [], executing: [], automated: [], recent: [] }
  for (const signal of signals) {
    buckets[classifySession(signal, separate)].push(signal)
  }

  const windowHours = clampToRange(config.recentWindowHours, 1, 720, 168)
  const maxRecent = clampToRange(config.maxRecent, 1, 200, 20)
  const thresholds: SeverityThresholds = {
    warnMinutes: config.decisionWarnMinutes ?? 15,
    criticalMinutes: config.decisionCriticalMinutes ?? 60,
  }

  const decision = buckets.decision
    .map(signal => {
      const waitingMs = waitingMsOf(signal, now)
      return toEntry(signal, { waitingMs, severity: decisionSeverity(waitingMs, thresholds) })
    })
    .sort(compareDecisions)
  const executing = [...buckets.executing].sort(compareByRecency).map(signal => toEntry(signal))
  const recentAll = [...buckets.recent]
    .filter(signal => isWithinWindow(signal, now, windowHours))
    .sort(compareByRecency)
    .map(signal => toEntry(signal))
  const recent = recentAll.slice(0, maxRecent)
  const truncated = recentAll.length - recent.length

  // Automated sessions follow the `recent` rules (window, cap) except that one
  // still running is always shown: hiding live work behind a cap would lie.
  const automatedAll = [...buckets.automated]
    .filter(signal => signal.running || isWithinWindow(signal, now, windowHours))
    .sort(compareByRecency)
    .map(signal => toEntry(signal))
  const automated = automatedAll.slice(0, Math.max(maxRecent, automatedAll.filter(entry => entry.running === true).length))
  const automatedTruncated = automatedAll.length - automated.length

  const orders: Record<BucketId, BoardBucket> = {
    decision: bucket('decision', decision),
    executing: bucket('executing', executing),
    automated: bucket('automated', automated, automatedTruncated),
    recent: bucket('recent', recent, truncated),
  }

  const ordered = BUCKET_IDS.filter(id => id !== 'automated' || separate).map(id => orders[id])
  const counts: Record<CoreBucketId, number> & { automated?: number } = {
    decision: decision.length,
    executing: executing.length,
    recent: recent.length,
  }
  if (separate) counts.automated = automated.length
  return { generatedAt: now, windowHours, buckets: ordered, counts }
}

// ── Filtering ───────────────────────────────────────────────────────────────

/** The scope that actually applies: `current` needs an active workspace to mean anything. */
export function effectiveScope(filter: BoardFilterState, activeWorkspaceId: string | undefined): WorkspaceScope {
  return filter.workspaceScope === 'current' && activeWorkspaceId !== undefined ? 'current' : 'all'
}

/** Whether the filter narrows anything right now. */
export function isFilterActive(filter: BoardFilterState, activeWorkspaceId: string | undefined): boolean {
  return filter.keyword.trim().length > 0 || effectiveScope(filter, activeWorkspaceId) === 'current'
}

/**
 * Narrow sessions by workspace scope and keyword.
 *
 * Runs after the top-level sessions are known and before classification and the
 * `maxRecent` cap, so counts and the "older sessions hidden" note describe what
 * the user is actually looking at. Pure and synchronous: zero debounce is cheap.
 *
 * @param sessions - candidate sessions.
 * @param filter - the user's scope and keyword.
 * @param activeWorkspaceId - the workspace on screen, when the host reports one.
 */
export function applyBoardFilter<T extends Pick<SessionSignal, 'title' | 'workspaceId' | 'workspaceName'>>(
  sessions: readonly T[],
  filter: BoardFilterState,
  activeWorkspaceId: string | undefined,
): T[] {
  const scoped = effectiveScope(filter, activeWorkspaceId) === 'current'
  const needle = filter.keyword.trim().toLowerCase()
  if (!scoped && needle.length === 0) return [...sessions]
  return sessions.filter(session => {
    if (scoped && session.workspaceId !== activeWorkspaceId) return false
    if (needle.length === 0) return true
    return (
      session.title.toLowerCase().includes(needle) ||
      (session.workspaceName?.toLowerCase().includes(needle) ?? false)
    )
  })
}

/** Total number of rows currently visible across every board. */
export function totalRows(snapshot: BoardSnapshot): number {
  return snapshot.buckets.reduce((sum, board) => sum + board.entries.length, 0)
}

/** Resolve the configured initial collapse mode into a concrete state. */
export function resolveCollapse(mode: CollapseMode): CollapseState {
  const collapsed = mode === 'all'
  return {
    decision: collapsed || mode === 'decision',
    executing: collapsed || mode === 'executing',
    automated: collapsed || mode === 'automated',
    recent: collapsed || mode === 'recent',
  }
}

/** Flip one board's collapse state, returning a new immutable state. */
export function toggleCollapse(state: CollapseState, id: BucketId): CollapseState {
  return { ...state, [id]: !state[id] }
}

/** Whether `id` is collapsed in `state`. */
export function isCollapsed(state: CollapseState, id: BucketId): boolean {
  return state[id]
}

/**
 * The accessible label the toggle button announces: it names the board, the
 * resulting action, and the row count, so a screen-reader user does not need
 * the visual badge.
 */
export function bucketToggleLabel(
  translate: (key: 'bucket.expand' | 'bucket.collapse', params: Record<string, string | number>) => string,
  name: string,
  collapsed: boolean,
  count: number,
): string {
  return translate(collapsed ? 'bucket.expand' : 'bucket.collapse', { name, count })
}