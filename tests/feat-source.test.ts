/** Adapter additions: subagent aggregation, snippets, workspaces, question kinds, ask time. */
import { describe, expect, it } from 'vitest'
import {
  collectSessionSignals,
  isAutomatedSummary,
  questionsOf,
  resolveActiveWorkspaceId,
  sanitizeSnippet,
} from '../src/client/session-source.ts'
import type { SessionListLike, SessionSummaryLike } from '../src/client/session-source.ts'

function list(rows: SessionSummaryLike[], projections?: SessionListLike['projectionsBySession']): SessionListLike {
  return { byId: Object.fromEntries(rows.map(r => [r.id as string, r])), phase: 'ready', projectionsBySession: projections }
}
const row = (id: string, extra: Partial<SessionSummaryLike> = {}): SessionSummaryLike => ({
  id,
  displayTitle: id,
  running: false,
  updatedAt: 1,
  ...extra,
})

describe('subagent aggregation', () => {
  it('counts children on the parent and never lists them', () => {
    const signals = collectSessionSignals(
      list([
        row('root'),
        row('c1', { parentId: 'root', origin: 'subagent', running: true }),
        row('c2', { parentId: 'root', origin: 'subagent', running: true }),
        row('c3', { parentId: 'root', origin: 'subagent', running: false }),
      ]),
    )
    expect(signals.map(s => s.id)).toEqual(['root'])
    expect(signals[0]?.subagentStats).toEqual({ total: 3, running: 2 })
  })

  it('credits a grandchild to the top-level ancestor', () => {
    const signals = collectSessionSignals(
      list([
        row('root'),
        row('c1', { parentId: 'root', origin: 'subagent' }),
        row('g1', { parentId: 'c1', origin: 'subagent', running: true }),
      ]),
    )
    expect(signals[0]?.subagentStats).toEqual({ total: 2, running: 1 })
  })

  it('omits stats for a session without children', () => {
    expect(collectSessionSignals(list([row('solo')]))[0]?.subagentStats).toBeUndefined()
  })

  it('survives a parent cycle and a dangling parent', () => {
    const signals = collectSessionSignals(
      list([
        row('a', { parentId: 'b', origin: 'subagent' }),
        row('b', { parentId: 'a', origin: 'subagent' }),
        row('orphan', { parentId: 'gone', origin: 'subagent' }),
        row('top'),
      ]),
    )
    expect(signals.map(s => s.id)).toEqual(['top'])
  })
})

describe('sanitizeSnippet', () => {
  it('flattens code fences, tags and markdown into one plain line', () => {
    const out = sanitizeSnippet('## Title\n```ts\nconst a = 1\n```\n<script>alert(1)</script> **bold** [link](http://x)')
    expect(out).toBeDefined()
    expect(out).not.toMatch(/[\n`<>*#]/)
    expect(out).toContain('bold')
    expect(out).toContain('link')
  })
  it('cuts to 80 characters', () => {
    const out = sanitizeSnippet('word '.repeat(200)) ?? ''
    expect(Array.from(out).length).toBeLessThanOrEqual(80)
  })
  it('returns undefined for empty or non-string input', () => {
    expect(sanitizeSnippet('   \n ')).toBeUndefined()
    expect(sanitizeSnippet(42)).toBeUndefined()
    expect(sanitizeSnippet(undefined)).toBeUndefined()
  })
  it('handles a very long input without scanning all of it', () => {
    expect((sanitizeSnippet('x'.repeat(2_000_000)) ?? '').length).toBeLessThanOrEqual(80)
  })
})

describe('context preview', () => {
  it('carries snippet, tool and tokens when the snapshot has them', () => {
    const [signal] = collectSessionSignals(
      list([row('s', { lastMessageText: 'Reading **files**\nnow', activeToolName: 'read', tokenCount: 14_230 })]),
    )
    expect(signal?.contextPreview).toEqual({ snippet: 'Reading files now', activeTool: 'read', tokenCount: 14_230 })
  })
  it('is absent when the snapshot has none of it', () => {
    expect(collectSessionSignals(list([row('s')]))[0]?.contextPreview).toBeUndefined()
  })
  it('ignores a non-positive or non-finite token count', () => {
    expect(collectSessionSignals(list([row('s', { tokenCount: -5 })]))[0]?.contextPreview).toBeUndefined()
    expect(collectSessionSignals(list([row('s', { tokenCount: Number.NaN })]))[0]?.contextPreview).toBeUndefined()
  })
})

describe('automated origin', () => {
  it('recognises the automation origins', () => {
    for (const origin of ['cron', 'schedule', 'webhook', 'automation']) {
      expect(isAutomatedSummary({ id: 'x', origin })).toBe(true)
    }
    expect(isAutomatedSummary({ id: 'x', origin: 'subagent' })).toBe(false)
    expect(isAutomatedSummary({ id: 'x' })).toBe(false)
  })
  it('flags the signal', () => {
    const signals = collectSessionSignals(list([row('a', { origin: 'cron' as never }), row('b')]))
    expect(signals.find(s => s.id === 'a')?.isAutomatedOrigin).toBe(true)
    expect(signals.find(s => s.id === 'b')?.isAutomatedOrigin).toBeUndefined()
  })
})

describe('workspaces', () => {
  const workspaces = {
    items: [
      { workspaceId: 'w1', title: 'Alpha', path: '/a', sessionIds: ['s1'] },
      { workspaceId: 'w2', title: 'Beta', path: '/b', sessionIds: [] },
    ],
  }
  it('attributes by the workspace list, then by cwd', () => {
    const signals = collectSessionSignals(list([row('s1'), row('s2', { cwd: '/b' }), row('s3')]), { workspaces })
    expect(signals.find(s => s.id === 's1')).toMatchObject({ workspaceId: 'w1', workspaceName: 'Alpha' })
    expect(signals.find(s => s.id === 's2')).toMatchObject({ workspaceId: 'w2', workspaceName: 'Beta' })
    expect(signals.find(s => s.id === 's3')?.workspaceId).toBeUndefined()
  })
  it('prefers fields on the row itself', () => {
    const [signal] = collectSessionSignals(list([row('s1', { workspaceId: 'x', workspaceName: 'Own' })]), { workspaces })
    expect(signal).toMatchObject({ workspaceId: 'x', workspaceName: 'Own' })
  })
  it('hides archived sessions', () => {
    const signals = collectSessionSignals(list([row('s1'), row('s2')]), { workspaces: { ...workspaces, archivedSessionIds: ['s2'] } })
    expect(signals.map(s => s.id)).toEqual(['s1'])
  })
  it('derives the active workspace from the session in the main view', () => {
    const snapshot = list([row('s1', { retainedBy: { mainView: 1 } }), row('s2')])
    expect(resolveActiveWorkspaceId(snapshot, workspaces)).toBe('w1')
  })
  it('follows a subagent in the main view to its parent workspace', () => {
    const snapshot = list([row('s1'), row('kid', { parentId: 's1', origin: 'subagent', retainedBy: { mainView: 1 } })])
    expect(resolveActiveWorkspaceId(snapshot, workspaces)).toBe('w1')
  })
  it('is undefined when nothing is on screen or no workspace is known', () => {
    expect(resolveActiveWorkspaceId(list([row('s1')]), workspaces)).toBeUndefined()
    expect(resolveActiveWorkspaceId(list([row('s9', { retainedBy: { mainView: 1 } })]), workspaces)).toBeUndefined()
    expect(resolveActiveWorkspaceId(undefined, workspaces)).toBeUndefined()
  })
})

describe('question kinds and ask time', () => {
  const projection = (call: Record<string, unknown>) => ({ values: { userQuestions: { active: [call] } } })
  const base = { callId: 'c', state: 'continued' }

  it('classifies the five families from real payloads', () => {
    const kind = (questions: unknown[]) =>
      questionsOf(projection({ ...base, questions }))[0]?.kind
    expect(kind([{ id: 'q', question: 'Why?' }])).toBe('continued')
    expect(kind([{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }])).toBe('single_select')
    expect(kind([{ id: 'q', question: 'Pick', options: [{ label: 'A' }], multiSelect: true }])).toBe('multi_select')
    expect(
      kind([{ id: 'q', question: 'Plan?', detail: 'steps', options: [{ label: 'Go' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Go' } }]),
    ).toBe('confirm')
    expect(kind([{ id: 'a', question: '1' }, { id: 'b', question: '2' }])).toBe('complex_open')
  })

  it('falls back to complex_open when a question cannot be read', () => {
    const [call] = questionsOf(projection({ ...base, questions: [{ id: 'a', question: 'ok' }, { id: '', question: 'bad' }] }))
    expect(call?.kind).toBe('complex_open')
    expect(call?.questions).toHaveLength(1)
  })

  it('drops an unknown intent instead of guessing', () => {
    const [call] = questionsOf(projection({ ...base, questions: [{ id: 'q', question: 'x', intent: { kind: 'mystery', approve: 'y' } }] }))
    expect(call?.questions[0]?.intent).toBeUndefined()
  })

  it('reads the ask time from the snapshot in ms, seconds or ISO form', () => {
    const at = (value: unknown) => questionsOf(projection({ ...base, createdAt: value, questions: [{ id: 'q', question: 'x' }] }))[0]?.askedAtMs
    expect(at(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(at(1_700_000_000)).toBe(1_700_000_000_000)
    expect(at('2023-11-14T22:13:20.000Z')).toBe(1_700_000_000_000)
    expect(at('garbage')).toBeUndefined()
    expect(at(-4)).toBeUndefined()
  })

  it('uses the oldest ask time across a session\'s calls', () => {
    const [signal] = collectSessionSignals(
      list([row('s')], {
        s: {
          values: {
            userQuestions: {
              active: [
                { ...base, callId: 'new', createdAt: 2_000_000_000_000, questions: [{ id: 'q', question: 'x' }] },
                { ...base, callId: 'old', createdAt: 1_900_000_000_000, questions: [{ id: 'r', question: 'y' }] },
              ],
            },
          },
        },
      }),
    )
    expect(signal?.askedAtMs).toBe(1_900_000_000_000)
  })

  it('does not set an ask time on a session that is not waiting', () => {
    expect(collectSessionSignals(list([row('s')]))[0]?.askedAtMs).toBeUndefined()
  })
})
