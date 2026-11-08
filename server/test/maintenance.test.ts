import { describe, expect, it } from 'vitest';
import { isMaintenanceExempt, maintenanceStartedAt, maintenanceState, type MaintenanceSettings } from '../src/shared/index.ts';

const now = Date.parse('2026-10-18T10:00:00Z');
const at = (hours: number) => new Date(now + hours*3_600_000).toISOString();
const base: MaintenanceSettings = { enabled: false, title: 'Upgrade', message: '', scope: 'FULL', startAt: null, endAt: null, startedAt: null, updates: [], autoSchedule: false, previewHours: 24, allowEmails: [] };
describe('maintenance schedule boundaries', () => {
  it('gives the manual switch priority and retains its real start time', () => {
    const manual = { ...base, enabled: true, autoSchedule: true, startAt: at(1), endAt: at(-1), startedAt: at(-2) };
    expect(maintenanceState(manual,now)).toBe('active');
    expect(maintenanceStartedAt(manual)).toBe(at(-2));
  });
  it('starts inclusively and restores access at the end without a scheduler job', () => {
    const planned = { ...base, autoSchedule: true, startAt: at(0), endAt: at(1) };
    expect(maintenanceState(planned,now)).toBe('active');
    expect(maintenanceState(planned,now+3_600_000)).toBe('off');
    expect(maintenanceStartedAt(planned)).toBe(at(0));
    expect(maintenanceState({ ...planned, endAt: null },now+10*3_600_000)).toBe('active');
  });
  it('shows advance notice only within the configured window', () => {
    const planned = { ...base, autoSchedule: true, startAt: at(24) };
    expect(maintenanceState(planned,now)).toBe('upcoming');
    expect(maintenanceState({ ...planned, startAt: at(25) },now)).toBe('off');
    expect(maintenanceState({ ...planned, previewHours: 0 },now)).toBe('off');
    expect(maintenanceState({ ...planned, autoSchedule: false },now)).toBe('off');
  });
  it('exempts only explicitly allowed emails, regardless of casing', () => {
    const allowed = { ...base, allowEmails: ['member@example.com'] };
    expect(isMaintenanceExempt(allowed,'Member@Example.com')).toBe(true);
    expect(isMaintenanceExempt(allowed,'other@example.com')).toBe(false);
    expect(isMaintenanceExempt(allowed,null)).toBe(false);
  });
});
