/**
 * Types shared by the Host half, the Client half, and the unit tests.
 *
 * Nothing here imports a Harness package: the board's contract has to stay
 * valid on both sides of the wire and in plain Node test runs.
 * @module dsh-plugin-status-board/shared/types
 */

/**
 * Every board, in the fixed order they are rendered.
 *
 * `automated` is only materialised when `separateAutomatedSessions` is on; the
 * classic three boards are always present. (`unread` is a view-level split of
 * `recent` driven by the host's `useSessionStatus`, not a classifier output, so
 * it is not part of this list.)
 */
export const BUCKET_IDS = ['decision', 'executing', 'automated', 'recent'] as const

/** Identity of one board. */
export type BucketId = (typeof BUCKET_IDS)[number]

/** Boards every snapshot carries, regardless of configuration. */
export type CoreBucketId = Exclude<BucketId, 'automated'>

/** How long a decision has been blocking, bucketed by the configured thresholds. */
export type DecisionSeverity = 'normal' | 'warning' | 'critical'

/** Normalised question families the inline card renders differently. */
export type QuestionKind = 'continued' | 'single_select' | 'multi_select' | 'confirm' | 'complex_open'

/** Workspace scope of the floating board's filter. */
export type WorkspaceScope = 'all' | 'current'

/** Filter applied to the floating board only; the global counters ignore it. */
export interface BoardFilterState {
  readonly workspaceScope: WorkspaceScope
  readonly keyword: string
}

/** Density of the floating board's rows. */
export type PanelDensity = 'comfortable' | 'compact'

/** One selectable answer to a question. */
export interface QuestionOption {
  /** Label sent back as the selected value. */
  readonly label: string
  /** Optional explanation shown under the label. */
  readonly description?: string | undefined
}

/** One question in an `ask_user_question` batch. */
export interface SessionQuestion {
  readonly id: string
  readonly question: string
  /** Long-form detail (for example the plan under review). */
  readonly detail?: string | undefined
  /** Short heading the asker supplied. */
  readonly header?: string | undefined
  readonly options?: readonly QuestionOption[] | undefined
  readonly multiSelect?: boolean | undefined
  /**
   * Presentation intent declared by the asker. Only `plan-review` is understood:
   * `approve` names the option label that approves the plan. Any other intent is
   * dropped, which leaves the generic option flow.
   */
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string } | undefined
}

/** State of one answerable question call. */
export type QuestionState = 'open' | 'continued'

/** One `ask_user_question` call currently waiting for the user. */
export interface ActiveQuestion {
  /** Tool-call identity the answer must name. */
  readonly callId: string
  /** Questions in this batch; normally one. */
  readonly questions: readonly SessionQuestion[]
  /**
   * `open` while the foreground wait is still live, `continued` once the tool
   * returned pending or the original process ended.
   */
  readonly state: QuestionState
  /**
   * Card family, classified by the adapter. Optional so a hand-built call (a
   * test, a future adapter) still renders: the card derives it when absent.
   */
  readonly kind?: QuestionKind | undefined
  /** First paragraph of the review detail, stripped and cut to 500 characters. */
  readonly summaryPreview?: string | undefined
  /** Epoch ms the question was asked, when the snapshot carries it. */
  readonly askedAtMs?: number | undefined
}

/** One answer in an answer batch. */
export interface QuestionAnswer {
  readonly id: string
  /** Selected option labels; empty means "skipped". */
  readonly selected: readonly string[]
  /** Free-text answer, sent alongside or instead of the options. */
  readonly custom?: string | undefined
}

/** The complete structured answer for one question call. */
export interface AnswerBatch {
  readonly answers: readonly QuestionAnswer[]
}

/**
 * What one Session looks like to the classifier.
 *
 * This is deliberately narrower than any runtime snapshot: an adapter is
 * responsible for reducing whatever the Harness publishes into this shape,
 * and every field below has a documented meaning so the classification can be
 * tested without a live Harness.
 */
export interface SessionSignal {
  /** Stable Session id. */
  readonly id: string
  /** Human-readable title, already trimmed by the adapter. */
  readonly title: string
  /** Workspace directory the Session runs in, when the adapter knows it. */
  readonly workspacePath?: string | undefined
  /** Whether the Session's Agent is currently working. */
  readonly running: boolean
  /**
   * Whether the Session is blocked on a decision only the user can make.
   *
   * Derived from the Session's `userQuestions` projection: a parked
   * `ask_user_question` entry, i.e. the tool waiting for a human answer (plan
   * review included). Such a Session outranks `running` — work cannot continue
   * until the user acts.
   *
   * Two things are deliberately NOT here:
   *
   * - A pending *approval*: the Conversation's own approval UI renders it and it
   *   is not published as a session-list projection, so no field of this shape
   *   can see it.
   * - A `pending` team task: measured on disk, a team board keeps its task rows
   *   `pending` forever after a ticket ends (`ready` is absent from the wire),
   *   so keying on it pinned finished sessions to the decision board.
   */
  readonly awaitingDecision: boolean
  /**
   * Answerable question calls carried by the Session's `userQuestions`
   * projection, in ask order. Only populated while a human answer is pending;
   * `undefined`/empty means the Session has no question card to render.
   */
  readonly questions?: readonly ActiveQuestion[] | undefined
  /** Workspace the Session belongs to, when the host says so. */
  readonly workspaceId?: string | undefined
  /** Display name of that Workspace. */
  readonly workspaceName?: string | undefined
  /** Started by a schedule, webhook or other automation rather than a person. */
  readonly isAutomatedOrigin?: boolean | undefined
  /** Epoch ms the pending question was asked, straight from the snapshot. */
  readonly askedAtMs?: number | undefined
  /** Subagent children that belong to this Session (children are never rows). */
  readonly subagentStats?: SubagentStats | undefined
  /** One-line context the row can show under its title. */
  readonly contextPreview?: ContextPreview | undefined
  /**
   * Epoch milliseconds of the Session's newest observed activity. `0` means
   * "not known", which keeps a Session visible instead of silently dropping
   * it.
   *
   * Fed by `updatedAt`, the only timestamp the Harness session summary
   * publishes today.
   */
  readonly lastActivityAt: number
}

/** Subagent children counted against their top-level Session. */
export interface SubagentStats {
  readonly total: number
  readonly running: number
}

/** Cleaned, bounded context a row may show. */
export interface ContextPreview {
  /** Single line, at most 80 characters. */
  readonly snippet?: string | undefined
  readonly activeTool?: string | undefined
  readonly tokenCount?: number | undefined
}

/** One rendered row. */
export interface BoardEntry {
  readonly id: string
  readonly title: string
  readonly workspacePath?: string | undefined
  readonly workspaceId?: string | undefined
  readonly workspaceName?: string | undefined
  readonly lastActivityAt: number
  /** The Session's Agent is working (used to count automated rows as running). */
  readonly running?: boolean | undefined
  /** Answerable question calls, when the Session currently has one. */
  readonly questions?: readonly ActiveQuestion[] | undefined
  /** How long the decision has been blocking (decision rows only). */
  readonly waitingMs?: number | undefined
  /** Severity bucket of {@link waitingMs} (decision rows only). */
  readonly severity?: DecisionSeverity | undefined
  readonly subagentStats?: SubagentStats | undefined
  readonly contextPreview?: ContextPreview | undefined
}

/** One board: its rows plus how many rows the cap hid. */
export interface BoardBucket {
  readonly id: BucketId
  readonly entries: readonly BoardEntry[]
  /** Rows dropped by the `maxRecent` cap (always `0` outside `recent`). */
  readonly truncated: number
}

/** The whole board, ready to render. */
export interface BoardSnapshot {
  /** Epoch milliseconds the snapshot was built at. */
  readonly generatedAt: number
  /** Window applied to `recent`, in hours. */
  readonly windowHours: number
  /** Always contains all three boards, in {@link BUCKET_IDS} order. */
  readonly buckets: readonly BoardBucket[]
  /** Per-board row counts (after the cap). `automated` exists only when that board does. */
  readonly counts: Readonly<Record<CoreBucketId, number>> & { readonly automated?: number }
}

/** Collapse state of the boards. `true` means "collapsed". */
export type CollapseState = Readonly<Record<BucketId, boolean>>

/** Which boards start collapsed. */
export type CollapseMode = BucketId | 'none' | 'all'

/** Resolved, defaulted plugin configuration. */
export interface ResolvedStatusBoardConfig {
  /** Width of the "recent records" window, in hours. */
  readonly recentWindowHours: number
  /** Maximum rows shown in the "recent records" board. */
  readonly maxRecent: number
  /** Boards that start collapsed. */
  readonly defaultCollapsed: CollapseMode
  /** Whether empty boards still render their header. */
  readonly showEmptyBuckets: boolean
  /** Show the badge on the collapsed sidebar's expand button. */
  readonly showCollapsedBadge: boolean
  /** Decision blocking time (minutes) at which the row turns to a warning. */
  readonly decisionWarnMinutes: number
  /** Decision blocking time (minutes) at which the row turns critical. Never below the warn threshold. */
  readonly decisionCriticalMinutes: number
  /** Give scheduled / automated sessions their own board. */
  readonly separateAutomatedSessions: boolean
  /** Row density of the floating board. */
  readonly panelDensity: PanelDensity
}

/** Raw configuration as it arrives from `cordis.patch.yml`. */
export interface StatusBoardConfig {
  readonly recentWindowHours?: number | undefined
  readonly maxRecent?: number | undefined
  readonly defaultCollapsed?: CollapseMode | undefined
  readonly showEmptyBuckets?: boolean | undefined
  readonly showCollapsedBadge?: boolean | undefined
  readonly decisionWarnMinutes?: number | undefined
  readonly decisionCriticalMinutes?: number | undefined
  readonly separateAutomatedSessions?: boolean | undefined
  readonly panelDensity?: PanelDensity | undefined
}