/** Configuration additions of v0.6 – v0.8. */
import { describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, isCollapseMode, isPanelDensity, resolveConfig } from '../src/shared/config.ts'

describe('new configuration keys', () => {
  it('defaults', () => {
    const config = resolveConfig()
    expect(config).toMatchObject({
      showCollapsedBadge: true,
      decisionWarnMinutes: 15,
      decisionCriticalMinutes: 60,
      separateAutomatedSessions: false,
      panelDensity: 'comfortable',
    })
    expect(config).toEqual(CONFIG_DEFAULTS)
  })

  it('falls back for values of the wrong type', () => {
    const config = resolveConfig({
      showCollapsedBadge: 'yes' as never,
      decisionWarnMinutes: 'soon' as never,
      decisionCriticalMinutes: Number.NaN,
      separateAutomatedSessions: 1 as never,
      panelDensity: 'huge' as never,
    })
    expect(config).toEqual(CONFIG_DEFAULTS)
  })

  it('clamps the thresholds into range', () => {
    expect(resolveConfig({ decisionWarnMinutes: 0 }).decisionWarnMinutes).toBe(1)
    expect(resolveConfig({ decisionWarnMinutes: 99_999 }).decisionWarnMinutes).toBe(1440)
    expect(resolveConfig({ decisionCriticalMinutes: 1 }).decisionCriticalMinutes).toBe(15)
    expect(resolveConfig({ decisionCriticalMinutes: 99_999 }).decisionCriticalMinutes).toBe(4320)
  })

  it('lifts the critical threshold to the warning one', () => {
    const config = resolveConfig({ decisionWarnMinutes: 120, decisionCriticalMinutes: 30 })
    expect(config.decisionWarnMinutes).toBe(120)
    expect(config.decisionCriticalMinutes).toBe(120)
  })

  it('keeps valid overrides', () => {
    expect(
      resolveConfig({
        showCollapsedBadge: false,
        decisionWarnMinutes: 5,
        decisionCriticalMinutes: 30,
        separateAutomatedSessions: true,
        panelDensity: 'compact',
      }),
    ).toMatchObject({
      showCollapsedBadge: false,
      decisionWarnMinutes: 5,
      decisionCriticalMinutes: 30,
      separateAutomatedSessions: true,
      panelDensity: 'compact',
    })
  })

  it('accepts automated as a collapse mode and rejects unknown densities', () => {
    expect(isCollapseMode('automated')).toBe(true)
    expect(resolveConfig({ defaultCollapsed: 'automated' }).defaultCollapsed).toBe('automated')
    expect(isPanelDensity('compact')).toBe(true)
    expect(isPanelDensity('tiny')).toBe(false)
  })
})
