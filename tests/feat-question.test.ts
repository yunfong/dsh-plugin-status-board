/** Question classification, clipping and the batch runner. */
import { describe, expect, it } from 'vitest'
import {
  approveLabelOf,
  classifyQuestionCall,
  clip,
  declineLabelOf,
  firstParagraphOf,
  summaryPreviewOf,
} from '../src/shared/question.ts'
import { runBatch } from '../src/shared/batch.ts'
import type { SessionQuestion } from '../src/shared/types.ts'

const q = (extra: Partial<SessionQuestion> = {}): SessionQuestion => ({ id: 'q', question: 'Proceed?', ...extra })
const call = (...questions: SessionQuestion[]) => ({ questions })

describe('classifyQuestionCall', () => {
  it('plain text', () => expect(classifyQuestionCall(call(q()))).toBe('continued'))
  it('single select', () =>
    expect(classifyQuestionCall(call(q({ options: [{ label: 'A' }, { label: 'B' }] })))).toBe('single_select'))
  it('multi select', () =>
    expect(classifyQuestionCall(call(q({ options: [{ label: 'A' }], multiSelect: true })))).toBe('multi_select'))
  it('explicit multiSelect:false is single', () =>
    expect(classifyQuestionCall(call(q({ options: [{ label: 'A' }], multiSelect: false })))).toBe('single_select'))
  it('plan review is a confirm', () =>
    expect(
      classifyQuestionCall(
        call(q({ detail: 'plan', options: [{ label: 'Go' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Go' } })),
      ),
    ).toBe('confirm'))
  it('plan review that names a missing approve option is complex', () =>
    expect(
      classifyQuestionCall(call(q({ options: [{ label: 'Go' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Yes' } }))),
    ).toBe('complex_open'))
  it('plan review with a huge plan is complex', () =>
    expect(
      classifyQuestionCall(
        call(q({ detail: 'x'.repeat(5_000), options: [{ label: 'Go' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Go' } })),
      ),
    ).toBe('complex_open'))
  it('several questions are complex', () => expect(classifyQuestionCall(call(q(), q({ id: 'r' })))).toBe('complex_open'))
  it('no questions are complex', () => expect(classifyQuestionCall(call())).toBe('complex_open'))
  it('too many options are complex', () =>
    expect(
      classifyQuestionCall(call(q({ options: Array.from({ length: 30 }, (_, i) => ({ label: `o${i}` })) }))),
    ).toBe('complex_open'))
  it('a huge question text is complex', () =>
    expect(classifyQuestionCall(call(q({ question: 'x'.repeat(5_000) })))).toBe('complex_open'))
})

describe('plan-review labels', () => {
  const question = q({ options: [{ label: 'Go' }, { label: 'Nope' }, { label: 'Later' }], intent: { kind: 'plan-review', approve: 'Go' } })
  it('names approve and the first other option as decline', () => {
    expect(approveLabelOf(question)).toBe('Go')
    expect(declineLabelOf(question)).toBe('Nope')
  })
  it('has neither without an intent', () => {
    expect(approveLabelOf(q({ options: [{ label: 'Go' }] }))).toBeUndefined()
    expect(declineLabelOf(q())).toBeUndefined()
  })
})

describe('clipping', () => {
  it('cuts to the limit with an ellipsis', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
  })
  it('does not split a surrogate pair', () => {
    const out = clip('😀😀😀😀', 3)
    expect(Array.from(out)).toHaveLength(3)
    expect(out.endsWith('…')).toBe(true)
  })
  it('caps the review summary at 500 characters', () => {
    expect(Array.from(summaryPreviewOf('x'.repeat(2_000))).length).toBeLessThanOrEqual(500)
  })
  it('strips control characters but keeps line breaks', () => {
    expect(summaryPreviewOf('a\u0000b\nc')).toBe('ab\nc')
  })
  it('takes the first paragraph', () => {
    expect(firstParagraphOf('one\ntwo\n\nthree')).toBe('one\ntwo')
  })
})

describe('runBatch', () => {
  it('never runs more than the limit at once', async () => {
    let active = 0
    let peak = 0
    const result = await runBatch(
      Array.from({ length: 12 }, (_, i) => `s${i}`),
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 3))
        active -= 1
      },
    )
    expect(peak).toBe(5)
    expect(result.succeeded).toHaveLength(12)
    expect(result.failed).toEqual([])
  })

  it('keeps going after a failure and reports it', async () => {
    const seen: string[] = []
    const result = await runBatch(['a', 'b', 'c', 'd', 'e'], async id => {
      seen.push(id)
      if (id === 'c') throw new Error('refused')
    })
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(result.failed).toEqual([{ id: 'c', message: 'refused' }])
    expect([...result.succeeded].sort()).toEqual(['a', 'b', 'd', 'e'])
  })

  it('reports progress for every settled item', async () => {
    const progress: number[] = []
    await runBatch(['a', 'b', 'c'], async () => {}, done => progress.push(done))
    expect(progress).toEqual([1, 2, 3])
  })

  it('handles an empty batch', async () => {
    expect(await runBatch([], async () => {})).toEqual({ succeeded: [], failed: [] })
  })
})
