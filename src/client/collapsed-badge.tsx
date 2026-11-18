/**
 * The count badge on the collapsed sidebar's expand button (FEAT-01).
 *
 * The shell offers one non-interactive `single` slot for it, `sidebar.toggle.badge`
 * (rendered only while the sidebar is collapsed). This module owns three things:
 *
 * - **What it shows**: the same counters as the floating button, from the same
 *   {@link summarizeBoard}, so the two cannot disagree.
 * - **Whether it may register**: `single` slots refuse a second registration at the
 *   same priority, and the shipped settings plugin already holds priority 0 (it
 *   renders nothing on the web). The registrar therefore tries 0, then `-1`
 *   (lowest renders). On the desktop shell, where that occupant draws the app
 *   update dot, shadowing it would hide a real notification, so it gives up.
 * - **Never getting in the way**: the badge is `aria-hidden` and
 *   `pointer-events: none`; the expand button underneath keeps every click.
 * @module dsh-plugin-status-board/client/collapsed-badge
 */

import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { createTranslate } from '../shared/i18n.ts'
import { useSessionStatusMap, type UseSessionStatus } from './completion-unread.ts'
import { summarizeBoard } from './counts.ts'
import type { BoardStore } from './store.ts'
import { BADGE_CSS } from './styles.ts'

/** Largest number drawn before the badge says `99+`. */
export const BADGE_CAP = 99

/** Text of the capsule for a count. */
export function badgeText(count: number): string {
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count)
}

/**
 * The slot component.
 *
 * @param props - the store and the shell's `useSessionStatus` slot hook (optional:
 *   without it only decisions are counted, never an invented unread state).
 */
export function CollapsedBadge({
  store,
  useSessionStatus,
}: {
  readonly store: BoardStore
  readonly useSessionStatus?: UseSessionStatus | undefined
}): ReactElement | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  // Called on every render even without the hook, to keep the call order fixed.
  const statuses = useSessionStatusMap(useSessionStatus)
  const summary = summarizeBoard(state.board, statuses)
  if (!state.config.showCollapsedBadge) return null

  if (summary.urgent > 0) {
    const translate = createTranslate(state.locale)
    return (
      <>
        <style>{BADGE_CSS}</style>
        <span
          className="status-board__toggle-badge"
          data-tone={summary.decision > 0 ? 'decision' : 'unread'}
          aria-hidden="true"
          title={translate('badge.label', { count: summary.urgent })}
        >
          {badgeText(summary.urgent)}
        </span>
      </>
    )
  }
  if (summary.executing > 0) {
    return (
      <>
        <style>{BADGE_CSS}</style>
        <span className="status-board__toggle-dot" aria-hidden="true" />
      </>
    )
  }
  return null
}

/** The slice of the Cordis client context the registrar uses. */
export interface BadgeSlots {
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Priorities tried in order: the shared default, then the shadowing one. */
const PRIORITIES = [0, -1] as const

/** Whether the desktop shell (which draws its update dot in this slot) hosts us. */
function isDesktopShell(): boolean {
  return (globalThis as { dshDesktop?: unknown }).dshDesktop !== undefined
}

/**
 * Seat the badge, following `showCollapsedBadge` as the configuration lands.
 *
 * Meant to run inside `ctx.slots.inject('sidebar.toggle.badge', …)`, itself
 * inside `ctx.effect`, so the returned disposer runs on unload.
 *
 * @param slots - `ctx.slots`.
 * @param store - the board store (its config decides whether the seat is held).
 * @param warn - one-shot diagnostic sink (tests replace it).
 * @returns a disposer that unseats the badge and stops following the config.
 */
export function registerCollapsedBadge(
  slots: BadgeSlots,
  store: BoardStore,
  warn: (message: string) => void = message => console.warn(message),
): () => void {
  let seat: (() => void) | undefined
  let warned = false

  const Component = (props: { readonly useSessionStatus?: UseSessionStatus }): ReactElement | null =>
    createElement(CollapsedBadge, {
      store,
      ...(props.useSessionStatus === undefined ? {} : { useSessionStatus: props.useSessionStatus }),
    })

  const take = (): (() => void) | undefined => {
    let lastError: unknown
    for (const priority of PRIORITIES) {
      // Shadowing the host's occupant is only free where that occupant is idle.
      if (priority !== 0 && isDesktopShell()) break
      try {
        return slots.register({ name: 'sidebar.toggle.badge', id: 'status-board', priority }, Component)
      } catch (cause) {
        lastError = cause
      }
    }
    if (!warned) {
      warned = true
      const reason = lastError instanceof Error ? lastError.message : 'slot unavailable'
      warn(`[dsh-plugin-status-board] collapsed badge not installed: ${reason}`)
    }
    return undefined
  }

  const sync = (): void => {
    const wanted = store.getSnapshot().config.showCollapsedBadge
    if (wanted && seat === undefined) seat = take()
    else if (!wanted && seat !== undefined) {
      seat()
      seat = undefined
    }
  }

  const stop = store.subscribe(sync)
  sync()
  return () => {
    stop()
    seat?.()
    seat = undefined
  }
}
