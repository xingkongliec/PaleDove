import { CalendarClock, ChevronUp, CircleAlert, Info, Lock, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { MaintenanceScope, PublicMaintenance } from '../shared/index';
import { useT, type TFunction } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

/** 维护影响范围（文案 key 前缀与图标） */
export const MAINTENANCE_SCOPES: Record<MaintenanceScope, { key: 'notice' | 'readonly' | 'full'; icon: typeof Info }> = {
  NOTICE: { key: 'notice', icon: Info },
  READONLY: { key: 'readonly', icon: Lock },
  FULL: { key: 'full', icon: TriangleAlert },
};
export const SCOPES = Object.keys(MAINTENANCE_SCOPES) as MaintenanceScope[];

function ScopeTag({ scope }: { scope: MaintenanceScope }) {
  const t = useT();
  const s = MAINTENANCE_SCOPES[scope];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', scope === 'FULL' ? 'text-danger-text' : scope === 'READONLY' ? 'text-warning-text' : 'text-fg-3')}>
      <Icon className="size-3.5" />
      {t(`maintenance.${s.key}Short`)}
    </span>
  );
}

function timeRange(m: Pick<PublicMaintenance, 'startAt' | 'endAt'>) {
  if (!m.startAt && !m.endAt) return null;
  return `${m.startAt ? formatDate(m.startAt) : '—'} — ${m.endAt ? formatDate(m.endAt) : '—'}`;
}

/** 时长：3 小时 20 分钟 / 2 天 */
export function spanText(t: TFunction, ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return t('maintenance.minutes', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${t('maintenance.hours', { n: h })} ${t('maintenance.minutes', { n: m % 60 })}` : t('maintenance.hours', { n: h });
  return t('maintenance.days', { n: Math.round(h / 24) });
}

/** 距离计划开始还有多久：3 小时 20 分钟后 / 2 天后 */
export function untilText(t: TFunction, iso: string | null) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  return ms <= 0 ? t('maintenance.soon') : t('maintenance.later', { span: spanText(t, ms) });
}

/** 控制台顶部的维护提示条：维护中 / 即将开始（预告）；白名单用户和管理员能看到相应说明 */
export function MaintenanceBanner({ m, admin }: { m: PublicMaintenance; admin?: boolean }) {
  const t = useT();
  const upcoming = m.state === 'upcoming';
  const full = m.scope === 'FULL' && !upcoming;
  const range = timeRange(m);
  return (
    <div
      role="status"
      className={cn(
        'fade-in flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-[13px] sm:px-6',
        upcoming ? 'border-line bg-surface-2 text-fg-2' : full ? 'border-danger/20 bg-danger-soft text-danger-text' : 'border-warning-icon/25 bg-warning-soft text-warning-text',
      )}
    >
      {upcoming ? <CalendarClock className="size-4 shrink-0" /> : full ? <CircleAlert className="size-4 shrink-0" /> : <Wrench className="size-4 shrink-0" />}
      {upcoming && <span className="shrink-0 rounded bg-surface px-1.5 py-px text-xs font-medium ring-1 ring-line">{t('maintenance.upcomingTag', { when: untilText(t, m.startAt) })}</span>}
      <span className="font-medium">{m.title}</span>
      <ScopeTag scope={m.scope} />
      {m.message && <span className="min-w-0 flex-1 truncate opacity-90">{m.message}</span>}
      {range && <span className="tabular text-xs opacity-75">{range}</span>}
      {m.exempt && !admin && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium">
          <ShieldCheck className="size-3.5" />
          {t('maintenance.exempt')}
        </span>
      )}
      {admin && (
        <Link to="/admin/settings?tab=maintenance" className="ml-auto shrink-0 underline underline-offset-2">
          {t('maintenance.manage')}
        </Link>
      )}
    </div>
  );
}

/** 大范围维护时普通用户看到的页面 */
export function MaintenancePage({ m }: { m: PublicMaintenance }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const range = timeRange(m);
  return (
    <div className="page-enter mx-auto w-full max-w-3xl px-1 py-6 sm:px-2 sm:py-10">
      <h1 className="text-xl font-medium">{t('maintenance.pageTitle')}</h1>
      <div className="mt-4 border-t border-line pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-medium">{m.title}</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-3">
              {range && <span className="tabular">{range}</span>}
              <ScopeTag scope={m.scope} />
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-2">
            <Wrench className="size-3.5 text-warning-icon" />
            {t('maintenance.inProgress')}
          </span>
        </div>
        {m.message && <p className="mt-4 text-[14px] leading-relaxed whitespace-pre-wrap">{m.message}</p>}
        {m.startedAt && <div className="mt-4 text-xs text-fg-3">{t('maintenance.actualStart', { time: formatDate(m.startedAt) })}</div>}

        {m.updates.length > 0 && (
          <div className="mt-6">
            <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium outline-none hover:bg-surface-3">
              {t('maintenance.updates')}
              <ChevronUp className={cn('size-3.5 transition-transform duration-200', !open && 'rotate-180')} />
            </button>
            <div className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-smooth', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
              <div className="overflow-hidden">
                <ol className="mt-3 ml-1.5 space-y-5 border-l border-line pl-5">
                  {[...m.updates].reverse().map((u, i) => (
                    <li key={i} className="relative">
                      <span className="absolute top-[7px] -left-[25px] size-1.5 rounded-full bg-fg-4" />
                      <div className="flex items-center gap-2 text-[13px] text-fg-3">
                        <span className="tabular">{formatDate(u.at)}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                          <Wrench className="size-3 text-warning-icon" />
                          {t('maintenance.inProgress')}
                        </span>
                      </div>
                      <p className="mt-1 text-[14px] whitespace-pre-wrap">{u.text}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
