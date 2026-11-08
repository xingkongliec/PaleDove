export type MaintenanceScope = 'NOTICE' | 'READONLY' | 'FULL';
export interface MaintenanceSettings {
  enabled: boolean;
  title: string;
  message: string;
  scope: MaintenanceScope;
  startAt: string | null;
  endAt: string | null;
  startedAt: string | null;
  updates: Array<{ at: string; text: string }>;
  autoSchedule: boolean;
  previewHours: number;
  allowEmails: string[];
}
export type MaintenanceState = 'active' | 'upcoming' | 'off';
export type PublicMaintenance = Omit<MaintenanceSettings, 'allowEmails'> & {
  state: Exclude<MaintenanceState, 'off'>;
  exempt: boolean;
};

/** 手动开关优先；计划结束后自动恢复，预告期间不限制使用。 */
export function maintenanceState(m: MaintenanceSettings, now = Date.now()): MaintenanceState {
  if (m.enabled) return 'active';
  if (!m.autoSchedule || !m.startAt) return 'off';
  const start = Date.parse(m.startAt);
  const end = m.endAt ? Date.parse(m.endAt) : Infinity;
  if (now >= start && now < end) return 'active';
  if (now < start && m.previewHours > 0 && start - now <= m.previewHours * 3_600_000) return 'upcoming';
  return 'off';
}
export const maintenanceStartedAt = (m: MaintenanceSettings) => m.enabled ? m.startedAt : m.autoSchedule ? m.startAt : null;
export const isMaintenanceExempt = (m: MaintenanceSettings, email?: string | null) => !!email && m.allowEmails.includes(email.toLowerCase());
