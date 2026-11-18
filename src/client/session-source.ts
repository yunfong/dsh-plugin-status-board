/**
 * Reduce the Harness Client's session-list snapshot into {@link SessionSignal}s.
 *
 * This is the ONLY file that knows the shape of the runtime's session list. A
 * Harness release that renames a field changes this adapter and nothing else;
 * the classifier, the view and every test keep working against the reduced
 * shape.
 *
 * ## What this adapter learned from real data
 *
 * Every field read here was checked against the installed Harness AND against
 * 188 real session logs on disk (`SessionListState` publishes
 * `{ ids, byId, phase, projectionsBySession }`; a summary carries
 * `id / displayTitle / title? / cwd? / parentId? / origin? / running / blank /
 * updatedAt`).
 *
 * Two traps were found by auditing those logs rather than by reading types:
 *
 * 1. **`team/task.ready` does not exist.** A team board records
 *    `{ id, revision, subject, description, status, ... }`; there is no `ready`
 *    field on the wire, so a rule keyed on it is dead code. Worse, the tasks a
 *    board carries are the team's *historical* work items: a finished ticket
 *    keeps listing its `pending` tasks forever, so treating them as "needs a
 *    decision" pins a completed session to the decision board indefinitely.
 * 2. **A parked question is an `ask_user_question` call without its result.**
 *    That is what the logs show for a genuinely blocked session, and it is the
 *    only signal that truly puts work on the user's desk.
 *
 * The consequence: the decision board is driven ONLY by the `userQuestions`
 * projection. Anything broader invents a state the runtime does not have.
 * @module dsh-plugin-status-board/client/session-source
 */

import { classifyQuestionCall, clip, summaryPreviewOf } from '../shared/question.ts'
import type {
  ActiveQuestion,
  ContextPreview,
  QuestionOption,
  SessionQuestion,
  SessionSignal,
  SubagentStats,
} from '../shared/types.ts'

/** Longest single-line snippet a row may carry. */
export const SNIPPET_MAX = 80

/** `origin` values that mark a session started by automation rather than a person. */
const AUTOMATED_ORIGINS: ReadonlySet<string> = new Set(['cron', 'schedule', 'scheduled', 'webhook', 'automation'])

/**
 * The `userQuestions` projection face.
 *
 * `active` holds the questions currently waiting for a human answer. When the
 * deployment publishes this projection it is the cheapest correct signal; an
 * absent projection simply means "nothing is parked on this session".
 */
export interface UserQuestionsProjectionLike {
  readonly active?: readonly unknown[] | undefined
}

/** One session's projection values (only the slices this plugin reads). */
export interface ProjectionLike {
  readonly values?:
    | {
        readonly userQuestions?: UserQuestionsProjectionLike | undefined
      }
    | undefined
}

/** One session summary as the Client snapshot publishes it. */
export interface SessionSummaryLike {
  readonly id?: string | undefined
  /** Title the browser renders in the sidebar. */
  readonly displayTitle?: string | undefined
  /** Alternate title field some releases carry. */
  readonly title?: string | undefined
  /** Working directory of the session, when known. */
  readonly cwd?: string | undefined
  /** `'subagent'` for child sessions spawned by a delegation. */
  readonly origin?: string | undefined
  /** Durable direct parent id, present on child sessions. */
  readonly parentId?: string | undefined
  /** Whether the session's agent is currently working. */
  readonly running?: boolean | undefined
  /** A session that has never exchanged a message. */
  readonly blank?: boolean | undefined
  /** Workspace id, when the row carries one (otherwise it is derived from the workspace list). */
  readonly workspaceId?: string | undefined
  /** Workspace display name, when the row carries one. */
  readonly workspaceName?: string | undefined
  /** Latest assistant text or status line, when the snapshot has one. */
  readonly lastMessageText?: string | undefined
  /** Tool the agent is running right now, when the snapshot has one. */
  readonly activeToolName?: string | undefined
  /** Cumulative token use, when the snapshot has one. */
  readonly tokenCount?: number | undefined
  readonly totalTokens?: number | undefined
  /** Local ownership counts; `mainView > 0` marks the session on screen. */
  readonly retainedBy?: Readonly<Record<string, number | undefined>> | undefined
  /** Newest activity timestamp, when the snapshot carries one. */
  readonly lastActivityAt?: number | undefined
  /** Creation/update timestamp used when `lastActivityAt` is absent. */
  readonly updatedAt?: number | undefined
  /**
   * Projection values carried by the list row itself (the Host's list
   * projection column). The resident `projectionsBySession` map is the
   * fallback for compositions that only publish it there.
   */
  readonly projectionValues?: ProjectionValuesLike | undefined
}

/** The values slice of a session projection snapshot. */
export interface ProjectionValuesLike {
  readonly userQuestions?: UserQuestionsProjectionLike | undefined
}

/** The session-list snapshot the Client publishes (`SessionListState`). */
export interface SessionListLike {
  readonly byId?: Readonly<Record<string, SessionSummaryLike>> | undefined
  /** `'pending'` until the first enumeration settles. */
  readonly phase?: 'pending' | 'ready' | undefined
  readonly projectionsBySession?: Readonly<Record<string, ProjectionLike>> | undefined
}

/** One workspace row (the slice of `WorkspaceView` this plugin reads). */
export interface WorkspaceLike {
  readonly workspaceId?: string | undefined
  readonly path?: string | undefined
  readonly title?: string | undefined
  readonly sessionIds?: readonly string[] | undefined
}

/** The `workspaces` service snapshot (`ctx.workspaces.list`). */
export interface WorkspaceListLike {
  readonly items?: readonly WorkspaceLike[] | undefined
  readonly archivedSessionIds?: readonly string[] | undefined
}

/** Extra inputs to {@link collectSessionSignals}. */
export interface SignalContext {
  /** Snapshot of `ctx.workspaces.list`, used to attribute sessions to workspaces. */
  readonly workspaces?: WorkspaceListLike | undefined
}

/** The `sessions` service face this plugin consumes. */
export interface SessionsFace {
  readonly list?:
    | {
        getSnapshot(): SessionListLike
        subscribe(listener: () => void): () => void
      }
    | undefined
}

/**
 * Whether the session is blocked on a human answer.
 *
 * Only `userQuestions.active` counts. A team board's `pending` task must not:
 * those rows are the team's work items, they stay `pending` in the log of a
 * finished session forever, and no field marks one as waiting for the user.
 * Treating them as decisions was the defect that pinned a six-day-old completed
 * session to the decision board.
 */
export function isAwaitingDecision(projection: ProjectionLike | undefined): boolean {
  const active = projection?.values?.userQuestions?.active
  return Array.isArray(active) && active.length > 0
}

/** Narrow an unknown value to a string, trimming nothing. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the selectable options of one question, dropping malformed entries. */
function optionsOf(value: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: QuestionOption[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const label = stringOf(candidate.label)
    if (label === undefined) continue
    const description = stringOf(candidate.description)
    options.push({ label, ...(description === undefined ? {} : { description }) })
  }
  return options.length === 0 ? undefined : options
}

/** Read one question, or `undefined` when it cannot be rendered. */
function questionOf(value: unknown): SessionQuestion | undefined {
  if (!isRecord(value)) return undefined
  const id = stringOf(value.id)
  const question = stringOf(value.question)
  if (id === undefined || question === undefined) return undefined
  const detail = stringOf(value.detail)
  const header = stringOf(value.header)
  const options = optionsOf(value.options)
  const multiSelect = typeof value.multiSelect === 'boolean' ? value.multiSelect : undefined
  const intent = intentOf(value.intent)
  return {
    id,
    question,
    ...(detail === undefined ? {} : { detail }),
    ...(header === undefined ? {} : { header }),
    ...(options === undefined ? {} : { options }),
    ...(multiSelect === undefined ? {} : { multiSelect }),
    ...(intent === undefined ? {} : { intent }),
  }
}

/** Read a `plan-review` intent; any other shape is ignored (generic flow). */
function intentOf(value: unknown): SessionQuestion['intent'] {
  if (!isRecord(value) || value.kind !== 'plan-review') return undefined
  const approve = stringOf(value.approve)
  return approve === undefined ? undefined : { kind: 'plan-review', approve }
}

/** Parse a timestamp that may be epoch ms, epoch seconds or an ISO string. */
function timestampOf(value: unknown): number | undefined {
  let ms: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) ms = value
  else if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) ms = parsed
  }
  if (ms === undefined || ms <= 0) return undefined
  // Seconds-since-epoch values are below 1e11; nothing real in ms is.
  return ms < 1e11 ? ms * 1000 : ms
}

/** Ask time of one active call, from whichever field the snapshot spells it as. */
function askedAtOf(candidate: Record<string, unknown>): number | undefined {
  for (const key of ['createdAt', 'askedAt', 'timestamp', 'at']) {
    const stamp = timestampOf(candidate[key])
    if (stamp !== undefined) return stamp
  }
  return undefined
}

/**
 * Reduce the `userQuestions` projection into renderable question calls.
 *
 * The wire value is narrowed instead of trusted: an older Host, a proxy, or a
 * future schema can hand the board anything, and a malformed question must not
 * take down the row. An entry missing its call id, state, or every renderable
 * question is skipped; callers keep the raw `isAwaitingDecision` check for
 * classification so a malformed-but-present call still lands on the decision
 * board (and can be opened in the session) instead of silently disappearing.
 */
export function questionsOf(projection: ProjectionLike | undefined): readonly ActiveQuestion[] {
  const active = projection?.values?.userQuestions?.active
  if (!Array.isArray(active)) return []
  const calls: ActiveQuestion[] = []
  for (const candidate of active) {
    if (!isRecord(candidate)) continue
    const callId = stringOf(candidate.callId)
    const state = candidate.state === 'open' || candidate.state === 'continued' ? candidate.state : undefined
    if (callId === undefined || state === undefined || !Array.isArray(candidate.questions)) continue
    const questions: SessionQuestion[] = []
    let dropped = 0
    for (const item of candidate.questions) {
      const question = questionOf(item)
      if (question !== undefined) questions.push(question)
      else dropped += 1
    }
    if (questions.length === 0) continue
    // A call with a question the adapter could not read is not faithfully
    // representable inline, so it must not look like a one-question card.
    const kind = dropped > 0 ? 'complex_open' : classifyQuestionCall({ questions })
    const first = questions[0]
    const preview = first === undefined ? undefined : summaryPreviewOf(first.detail ?? first.question)
    const askedAtMs = askedAtOf(candidate)
    calls.push({
      callId,
      questions,
      state,
      kind,
      ...(preview === undefined || preview.length === 0 ? {} : { summaryPreview: preview }),
      ...(askedAtMs === undefined ? {} : { askedAtMs }),
    })
  }
  return calls
}

/** Oldest ask time across a session's active calls (the moment it first blocked). */
export function askedAtOfCalls(calls: readonly ActiveQuestion[]): number | undefined {
  let oldest: number | undefined
  for (const call of calls) {
    if (call.askedAtMs !== undefined && (oldest === undefined || call.askedAtMs < oldest)) oldest = call.askedAtMs
  }
  return oldest
}

/**
 * Reduce free text to one safe, plain line.
 *
 * Removes fenced and inline code markers, HTML tags and common Markdown
 * punctuation, collapses whitespace, then hard-cuts to {@link SNIPPET_MAX}. The
 * result is rendered as a React text node, so this is for layout and memory, not
 * for escaping.
 */
export function sanitizeSnippet(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Cut first so a megabyte of log never gets scanned by the regexes below.
  const head = value.slice(0, SNIPPET_MAX * 8)
  const plain = head
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#>|]+/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length === 0 ? undefined : clip(plain, SNIPPET_MAX)
}

/** Build the bounded context preview of one summary. */
function contextPreviewOf(summary: SessionSummaryLike): ContextPreview | undefined {
  const snippet = sanitizeSnippet(summary.lastMessageText)
  const activeTool = sanitizeSnippet(summary.activeToolName)
  const rawTokens = summary.tokenCount ?? summary.totalTokens
  const tokenCount = typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens > 0 ? Math.trunc(rawTokens) : undefined
  if (snippet === undefined && activeTool === undefined && tokenCount === undefined) return undefined
  return {
    ...(snippet === undefined ? {} : { snippet }),
    ...(activeTool === undefined ? {} : { activeTool }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
  }
}

/** Whether a summary was started by automation (`origin: 'subagent'` is never one). */
export function isAutomatedSummary(summary: SessionSummaryLike): boolean {
  return typeof summary.origin === 'string' && AUTOMATED_ORIGINS.has(summary.origin)
}

/** Whether a summary describes a subagent child rather than a top-level session. */
export function isSubagentChild(summary: SessionSummaryLike): boolean {
  return summary.origin === 'subagent' || (typeof summary.parentId === 'string' && summary.parentId.length > 0)
}

/** Pick the first non-blank title, falling back to the id. */
function titleOf(summary: SessionSummaryLike, id: string): string {
  for (const candidate of [summary.displayTitle, summary.title]) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return id
}

/** Pick the newest timestamp the summary carries, or `0` when it carries none. */
function lastActivityOf(summary: SessionSummaryLike): number {
  for (const candidate of [summary.lastActivityAt, summary.updatedAt]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate
  }
  return 0
}

/**
 * Resolve the projection values for one row.
 *
 * The Host publishes them on the row (`projectionValues`); older compositions
 * expose the resident store through `projectionsBySession`. Reading both keeps
 * the question card working across that shape change without touching the
 * classifier.
 */
function projectionOf(summary: SessionSummaryLike, id: string, list: SessionListLike | undefined): ProjectionLike | undefined {
  const rowQuestions = summary.projectionValues?.userQuestions
  if (rowQuestions !== undefined) return { values: { userQuestions: rowQuestions } }
  return list?.projectionsBySession?.[id]
}

/** Workspace attribution for every session id the workspace list names. */
function workspaceIndex(workspaces: WorkspaceListLike | undefined): {
  byId: Map<string, WorkspaceLike>
  byPath: Map<string, WorkspaceLike>
} {
  const byId = new Map<string, WorkspaceLike>()
  const byPath = new Map<string, WorkspaceLike>()
  for (const item of workspaces?.items ?? []) {
    if (typeof item !== 'object' || item === null) continue
    if (typeof item.path === 'string' && item.path.length > 0) byPath.set(item.path, item)
    for (const id of item.sessionIds ?? []) if (typeof id === 'string') byId.set(id, item)
  }
  return { byId, byPath }
}

/** The workspace a summary belongs to: its own fields first, then the list. */
function workspaceOf(
  summary: SessionSummaryLike,
  index: ReturnType<typeof workspaceIndex>,
): { id?: string; name?: string } {
  const listed = (typeof summary.id === 'string' ? index.byId.get(summary.id) : undefined) ??
    (typeof summary.cwd === 'string' ? index.byPath.get(summary.cwd) : undefined)
  const id = stringOf(summary.workspaceId) ?? stringOf(listed?.workspaceId)
  const name = stringOf(summary.workspaceName) ?? stringOf(listed?.title)
  return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) }
}

/**
 * The workspace on screen: the one owning the session shown in the main view.
 *
 * The host publishes no "active workspace" field, but it does mark the displayed
 * session (`retainedBy.mainView`), and every session belongs to a workspace.
 */
export function resolveActiveWorkspaceId(
  list: SessionListLike | undefined,
  workspaces: WorkspaceListLike | undefined,
): string | undefined {
  const byId = list?.byId
  if (byId === undefined) return undefined
  const index = workspaceIndex(workspaces)
  for (const summary of Object.values(byId)) {
    if (typeof summary !== 'object' || summary === null) continue
    if ((summary.retainedBy?.mainView ?? 0) <= 0) continue
    // A subagent open in the main view belongs to its parent's workspace.
    let cursor: SessionSummaryLike | undefined = summary
    for (let hops = 0; cursor !== undefined && hops < 8; hops += 1) {
      const id = workspaceOf(cursor, index).id
      if (id !== undefined) return id
      cursor = typeof cursor.parentId === 'string' ? byId[cursor.parentId] : undefined
    }
  }
  return undefined
}

/** Top-level ancestor id of a child, guarding against cycles and dangling parents. */
function rootOf(child: SessionSummaryLike, byId: Readonly<Record<string, SessionSummaryLike>>): string | undefined {
  const seen = new Set<string>()
  let cursor: SessionSummaryLike | undefined = child
  while (cursor !== undefined && isSubagentChild(cursor)) {
    const parent: string | undefined = stringOf(cursor.parentId)
    if (parent === undefined || seen.has(parent)) return undefined
    seen.add(parent)
    const next: SessionSummaryLike | undefined = byId[parent]
    if (next === undefined) return parent
    cursor = next
  }
  return cursor?.id
}

/**
 * Turn a session-list snapshot into the classifier's input.
 *
 * Skipped rows, each for a reason the board's question demands:
 * - subagent children — they are never listed as rows, but they are COUNTED on
 *   their top-level ancestor so the row can say "2 subagents running";
 * - blank sessions that never exchanged a message — they have no state to
 *   report, and their default title (the workspace name) reads as a phantom row.
 *
 * @param list - the snapshot (may be `undefined` before the first publication).
 * @param context - optional workspace snapshot for attribution.
 * @returns one signal per visible top-level session, in snapshot order.
 */
export function collectSessionSignals(list: SessionListLike | undefined, context?: SignalContext): SessionSignal[] {
  const byId = list?.byId
  if (byId === undefined) return []

  // Single pass over children first: counts per top-level ancestor.
  const stats = new Map<string, { total: number; running: number }>()
  for (const summary of Object.values(byId)) {
    if (typeof summary !== 'object' || summary === null) continue
    if (typeof summary.id !== 'string' || summary.id.length === 0) continue
    if (!isSubagentChild(summary)) continue
    const root = rootOf(summary, byId)
    if (root === undefined) continue
    const entry = stats.get(root) ?? { total: 0, running: 0 }
    entry.total += 1
    if (summary.running === true) entry.running += 1
    stats.set(root, entry)
  }

  const index = workspaceIndex(context?.workspaces)
  // An archived session is out of the user's working set; it must leave the
  // board when archived (including from this board's own archive action).
  const archived = new Set<string>(context?.workspaces?.archivedSessionIds ?? [])
  const signals: SessionSignal[] = []
  const seen = new Set<string>()
  for (const summary of Object.values(byId)) {
    if (typeof summary !== 'object' || summary === null) continue
    if (typeof summary.id !== 'string' || summary.id.length === 0) continue
    if (seen.has(summary.id)) continue
    if (archived.has(summary.id)) continue
    if (isSubagentChild(summary)) continue
    if (summary.blank === true) continue
    seen.add(summary.id)

    const projection = projectionOf(summary, summary.id, list)
    const questions = questionsOf(projection)
    const awaiting = isAwaitingDecision(projection)
    const workspace = workspaceOf(summary, index)
    const childStats = stats.get(summary.id)
    const subagentStats: SubagentStats | undefined =
      childStats === undefined ? undefined : { total: childStats.total, running: childStats.running }
    const preview = contextPreviewOf(summary)
    const askedAtMs = awaiting ? askedAtOfCalls(questions) : undefined
    signals.push({
      id: summary.id,
      title: titleOf(summary, summary.id),
      workspacePath: typeof summary.cwd === 'string' && summary.cwd.length > 0 ? summary.cwd : undefined,
      running: summary.running === true,
      awaitingDecision: awaiting,
      ...(questions.length === 0 ? {} : { questions }),
      ...(workspace.id === undefined ? {} : { workspaceId: workspace.id }),
      ...(workspace.name === undefined ? {} : { workspaceName: workspace.name }),
      ...(isAutomatedSummary(summary) ? { isAutomatedOrigin: true } : {}),
      ...(askedAtMs === undefined ? {} : { askedAtMs }),
      ...(subagentStats === undefined ? {} : { subagentStats }),
      ...(preview === undefined ? {} : { contextPreview: preview }),
      lastActivityAt: lastActivityOf(summary),
    })
  }
  return signals
}
