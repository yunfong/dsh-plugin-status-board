/** Locale parity for the v0.6 – v0.8 strings and the formatters they use. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createTranslate, formatDuration, formatMessage, formatTokenCount, lookup } from '../src/shared/i18n.ts'
import type { LocaleFile } from '../src/shared/i18n.ts'

const read = (id: string): LocaleFile => JSON.parse(readFileSync(fileURLToPath(new URL(`../locale/${id}.json`, import.meta.url)), 'utf8')) as LocaleFile
const flatten = (value: unknown, prefix = ''): string[] =>
  typeof value !== 'object' || value === null
    ? [prefix]
    : Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`)).sort()
const placeholders = (text: string): string[] => [...text.matchAll(/\{([^{}]+)\}/g)].map(m => m[1] as string).sort()

const NEW_KEYS = [
  'bucket.automated', 'bucket.automatedHint', 'bucket.automatedUnit', 'bucket.automatedEmpty',
  'filter.scopeLabel', 'filter.scopeAll', 'filter.scopeCurrent', 'filter.scopeCurrentUnavailable', 'filter.search',
  'filter.active', 'filter.activeHint', 'filter.clear', 'filter.noMatchClear', 'filter.hiddenByFilter',
  'row.waitingWarn', 'row.waitingCritical', 'row.subagentsRunning', 'row.subagentsTotal', 'row.tokens', 'row.tool',
  'badge.label', 'badge.running',
  'triage.archiveAll', 'triage.archiveAllLabel', 'triage.markAllRead', 'triage.markAllReadLabel', 'triage.confirm',
  'triage.confirmYes', 'triage.confirmNo', 'triage.busy', 'triage.failed', 'triage.done',
  'question.approve', 'question.reject', 'question.rejectNote', 'question.selectOne', 'question.selectAtLeastOne',
  'question.other', 'question.expand', 'question.collapse', 'question.openFull', 'question.complexNotice',
  'question.retryInSession', 'question.changed', 'question.answeredElsewhere',
]

describe('new copy', () => {
  const zh = read('zh')
  const en = read('en')
  it('every new key exists in both locales and is non-empty', () => {
    for (const key of NEW_KEYS) {
      expect(lookup(zh, key)?.length, `zh ${key}`).toBeGreaterThan(0)
      expect(lookup(en, key)?.length, `en ${key}`).toBeGreaterThan(0)
    }
  })
  it('both locales have identical key sets', () => expect(flatten(zh)).toEqual(flatten(en)))
  it('placeholders match between locales for every key', () => {
    for (const key of flatten(en)) {
      expect(placeholders(lookup(zh, key) ?? ''), key).toEqual(placeholders(lookup(en, key) ?? ''))
    }
  })
  it('the manifest descriptions mention the new boards', () => {
    expect(zh.meta.description).toContain('完成未看')
    expect(en.meta.description).toContain('Automated')
  })
})

describe('interpolation of the new messages', () => {
  const en = createTranslate('en')
  const zh = createTranslate('zh')
  it('formats the wait badges in both languages', () => {
    expect(en('row.waitingWarn', { duration: '25m' })).toBe('Waiting 25m')
    expect(zh('row.waitingWarn', { duration: '25m' })).toBe('等待 25m')
    expect(zh('row.waitingCritical', { duration: '2h' })).toBe('阻塞 2h')
    expect(zh('row.subagentsRunning', { running: 2 })).toBe('2 子代理运行中')
  })
  it('substitutes in a single pass', () => {
    expect(formatMessage('{a} {b}', { a: '{b}', b: 'x' })).toBe('{b} x')
    expect(en('triage.failed', { count: 2, message: '{count}' })).toBe('2 sessions could not be archived: {count}')
  })
})

describe('formatters', () => {
  const en = createTranslate('en')
  it('formats durations compactly with a one-minute floor', () => {
    expect(formatDuration(0, en)).toBe('1m')
    expect(formatDuration(25 * 60_000, en)).toBe('25m')
    expect(formatDuration(59 * 60_000, en)).toBe('59m')
    expect(formatDuration(60 * 60_000, en)).toBe('1h')
    expect(formatDuration(130 * 60_000, en)).toBe('2h')
    expect(formatDuration(49 * 3_600_000, en)).toBe('2d')
    expect(formatDuration(-5, en)).toBe('1m')
  })
  it('formats token counts', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(14_230)).toBe('14.2k')
    expect(formatTokenCount(1_000)).toBe('1k')
    expect(formatTokenCount(2_400_000)).toBe('2.4M')
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
  })
})
