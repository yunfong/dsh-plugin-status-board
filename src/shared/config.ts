/**
 * Configuration resolution.
 *
 * The Loader validates the row's `Config` schema before activation, so this
 * module only has to apply the same defaults for direct callers (tests, and
 * the Client half's fallback when it cannot reach the Host). Values are
 * clamped, not rejected: a hand-edited patch must never keep the panel from
 * rendering.
 * @module dsh-plugin-status-board/shared/config
 */

import {
  BUCKET_IDS,
  type CollapseMode,
  type PanelDensity,
  type ResolvedStatusBoardConfig,
  type StatusBoardConfig,
} from './types.ts'

/** Hard bounds used by both the schema and the resolver. */
export const CONFIG_LIMITS = {
  recentWindowHours: { min: 1, max: 720 },
  maxRecent: { min: 1, max: 200 },
  decisionWarnMinutes: { min: 1, max: 1440 },
  decisionCriticalMinutes: { min: 5, max: 4320 },
} as const

/** Defaults documented in README.md and used when a field is absent. */
export const CONFIG_DEFAULTS = {
  recentWindowHours: 168,
  maxRecent: 20,
  defaultCollapsed: 'recent' as CollapseMode,
  showEmptyBuckets: true,
  showCollapsedBadge: true,
  decisionWarnMinutes: 15,
  decisionCriticalMinutes: 60,
  separateAutomatedSessions: false,
  panelDensity: 'comfortable' as PanelDensity,
} as const

/** Clamp an unknown number into an inclusive integer range. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** Whether `value` names a board, `none`, or `all`. */
export function isCollapseMode(value: unknown): value is CollapseMode {
  return value === 'none' || value === 'all' || (typeof value === 'string' && (BUCKET_IDS as readonly string[]).includes(value))
}

/** Whether `value` is a known row density. */
export function isPanelDensity(value: unknown): value is PanelDensity {
  return value === 'comfortable' || value === 'compact'
}

/**
 * Apply defaults and bounds to a raw configuration object.
 *
 * @param raw - the row's `config` (may be `undefined` when the Loader supplies
 *   no configuration at all).
 * @returns a complete, immutable configuration.
 */
export function resolveConfig(raw?: StatusBoardConfig | null): ResolvedStatusBoardConfig {
  const warn = clampInt(
    raw?.decisionWarnMinutes,
    CONFIG_DEFAULTS.decisionWarnMinutes,
    CONFIG_LIMITS.decisionWarnMinutes.min,
    CONFIG_LIMITS.decisionWarnMinutes.max,
  )
  // The critical threshold may never sit below the warning one, otherwise a row
  // would skip the warning state entirely. Lift it instead of rejecting.
  const critical = Math.max(
    clampInt(
      raw?.decisionCriticalMinutes,
      CONFIG_DEFAULTS.decisionCriticalMinutes,
      CONFIG_LIMITS.decisionCriticalMinutes.min,
      CONFIG_LIMITS.decisionCriticalMinutes.max,
    ),
    warn,
  )
  return {
    recentWindowHours: clampInt(
      raw?.recentWindowHours,
      CONFIG_DEFAULTS.recentWindowHours,
      CONFIG_LIMITS.recentWindowHours.min,
      CONFIG_LIMITS.recentWindowHours.max,
    ),
    maxRecent: clampInt(raw?.maxRecent, CONFIG_DEFAULTS.maxRecent, CONFIG_LIMITS.maxRecent.min, CONFIG_LIMITS.maxRecent.max),
    defaultCollapsed: isCollapseMode(raw?.defaultCollapsed) ? raw.defaultCollapsed : CONFIG_DEFAULTS.defaultCollapsed,
    showEmptyBuckets: typeof raw?.showEmptyBuckets === 'boolean' ? raw.showEmptyBuckets : CONFIG_DEFAULTS.showEmptyBuckets,
    showCollapsedBadge:
      typeof raw?.showCollapsedBadge === 'boolean' ? raw.showCollapsedBadge : CONFIG_DEFAULTS.showCollapsedBadge,
    decisionWarnMinutes: warn,
    decisionCriticalMinutes: critical,
    separateAutomatedSessions:
      typeof raw?.separateAutomatedSessions === 'boolean'
        ? raw.separateAutomatedSessions
        : CONFIG_DEFAULTS.separateAutomatedSessions,
    panelDensity: isPanelDensity(raw?.panelDensity) ? raw.panelDensity : CONFIG_DEFAULTS.panelDensity,
  }
}