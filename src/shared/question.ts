/**
 * Question-card classification and text clipping.
 *
 * Pure and Harness-free: the adapter calls it on data it has already narrowed,
 * and the card calls it again for a hand-built call that carries no `kind`.
 * @module dsh-plugin-status-board/shared/question
 */

import type { ActiveQuestion, QuestionKind, SessionQuestion } from './types.ts'

/** Review text longer than this is not a "light" confirmation any more. */
export const CONFIRM_MAX_DETAIL = 4_000

/** A question with more choices than this is routed to the full session card. */
export const MAX_INLINE_OPTIONS = 12

/** Question text longer than this is routed to the full session card. */
export const MAX_INLINE_QUESTION = 2_000

/** Characters of review text the confirm card may ever show. */
export const SUMMARY_PREVIEW_MAX = 500

/**
 * Cut `text` to at most `max` code points, ending in an ellipsis when it was cut.
 *
 * Code points rather than UTF-16 units so a surrogate pair is never split.
 */
export function clip(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`
}

/** Strip control characters other than newline and tab. */
function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** The review summary the confirm card shows: bounded, newlines preserved. */
export function summaryPreviewOf(text: string): string {
  return clip(stripControl(text).trim(), SUMMARY_PREVIEW_MAX)
}

/** First paragraph of `text`, bounded. Used by the read-only fallback card. */
export function firstParagraphOf(text: string): string {
  const paragraph = stripControl(text).trim().split(/\n\s*\n/)[0] ?? ''
  return clip(paragraph.trim(), SUMMARY_PREVIEW_MAX)
}

/** The option label that approves a plan review, when the question declares one. */
export function approveLabelOf(question: SessionQuestion): string | undefined {
  const intent = question.intent
  if (intent === undefined) return undefined
  return question.options?.some(option => option.label === intent.approve) === true ? intent.approve : undefined
}

/** The label a rejection is sent as: the first option that is not the approval. */
export function declineLabelOf(question: SessionQuestion): string | undefined {
  const approve = approveLabelOf(question)
  if (approve === undefined) return undefined
  return question.options?.find(option => option.label !== approve)?.label
}

/**
 * Decide which card family a call needs.
 *
 * Anything the inline card cannot represent faithfully falls to `complex_open`,
 * which only shows a summary and sends the user to the session: wrong inline
 * submission is worse than one extra click.
 */
export function classifyQuestionCall(call: Pick<ActiveQuestion, 'questions'>): QuestionKind {
  if (call.questions.length !== 1) return 'complex_open'
  const [question] = call.questions
  if (question === undefined) return 'complex_open'
  const detailLength = question.detail?.length ?? 0
  if (question.question.length > MAX_INLINE_QUESTION || detailLength > CONFIRM_MAX_DETAIL * 2) return 'complex_open'
  const options = question.options ?? []
  if (options.length > MAX_INLINE_OPTIONS) return 'complex_open'

  if (question.intent !== undefined) {
    if (approveLabelOf(question) === undefined || declineLabelOf(question) === undefined) return 'complex_open'
    if (question.multiSelect === true) return 'complex_open'
    return detailLength > CONFIRM_MAX_DETAIL ? 'complex_open' : 'confirm'
  }
  if (options.length === 0) return 'continued'
  return question.multiSelect === true ? 'multi_select' : 'single_select'
}
