// 系统设置 → 维护模式：状态卡（快捷开始 / 结束）+ 分节表单 + 右侧实时预览用户看到的效果
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, Hand, Plus, Power, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MaintenanceSettings, PublicMaintenance } from '../../../shared/index';
import { MAINTENANCE_SCOPES, MaintenanceBanner, MaintenancePage, SCOPES, spanText, untilText } from '@/components/Maintenance';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { Card, Checkbox, ErrorState, FormCard, PageLoading, Switch } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/tabs';
import { useT, type TFunction } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

type Form = MaintenanceSettings;

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** 与服务端 maintenanceState 一致的状态判断（计划中的维护不论是否在预告期都算“已计划”） */
function stateOf(m: Form, now = Date.now()): 'active' | 'scheduled' | 'off' {
  if (m.enabled) return 'active';
  if (!m.autoSchedule || !m.startAt) return 'off';
  const start = Date.parse(m.startAt);
  const end = m.endAt ? Date.parse(m.endAt) : Infinity;
  if (now >= start && now < end) return 'active';
  return now < start ? 'scheduled' : 'off';
}

/** 常用的维护说明模板，点击填入 */
const TEMPLATES = ['database', 'network', 'upgrade'] as const;

export function MaintenanceSettingsCard() {
  const q = useQuery({ queryKey: ['maintenance-settings'], queryFn: () => api.get<MaintenanceSettings>('/admin/settings/maintenance'), refetchInterval: 30_000 });
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading />;
  return <MaintenanceForm value={q.data} />;
}

function MaintenanceForm({ value }: { value: Form }) {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(value);
  const [note, setNote] = useState('');
  const [emails, setEmails] = useState(value.allowEmails.join('\n'));
  const [announce, setAnnounce] = useState(false);
  const [announceEmail, setAnnounceEmail] = useState(false);
  // 每 30 秒刷新一次“已持续 / 多久后开始”
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  // 服务端返回新值（保存、快捷操作）后同步表单
  useEffect(() => {
    setForm(value);
    setEmails(value.allowEmails.join('\n'));
  }, [value]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const emailList = useMemo(() => [...new Set(emails.split(/[\s,;，；]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))], [emails]);
  const badEmail = emailList.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const timeError = form.startAt && form.endAt && Date.parse(form.endAt) <= Date.parse(form.startAt) ? t('maintenance.endAfterStart') : form.autoSchedule && !form.startAt ? t('maintenance.startRequired') : null;
  const titleError = !form.title.trim() ? t('maintenance.titleRequired') : null;
  const dirty = JSON.stringify({ ...form, allowEmails: emailList }) !== JSON.stringify(value) || announce;
  const saved = stateOf(value);

  const save = useMutation({
    mutationFn: ({ patch = {}, extra = {} }: { patch?: Partial<Form>; extra?: { announce?: boolean; announceEmail?: boolean } }) => {
      const next = { ...form, allowEmails: emailList, ...patch };
      return api.put<MaintenanceSettings>('/admin/settings/maintenance', {
        enabled: next.enabled,
        title: next.title.trim(),
        message: next.message,
        scope: next.scope,
        startAt: next.startAt,
        endAt: next.endAt,
        updates: next.updates,
        autoSchedule: next.autoSchedule,
        previewHours: next.previewHours,
        allowEmails: next.allowEmails,
        announce: extra.announce ?? announce,
        announceEmail: extra.announceEmail ?? (announce && announceEmail),
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(['maintenance-settings'], data);
      void qc.invalidateQueries({ queryKey: ['public-config'] });
      void qc.invalidateQueries({ queryKey: ['announcements'] });
      void qc.invalidateQueries({ queryKey: ['admin-announcements'] });
      setAnnounce(false);
      setAnnounceEmail(false);
      toast.success(t('adminSettings.saved'));
    },
    onError: (e) => toast.fromError(e),
  });

  const startNow = async () => {
    if (titleError) return toast.error(titleError);
    const s = MAINTENANCE_SCOPES[form.scope].key;
    if (
      !(await confirm({
        title: t('maintenance.startConfirm'),
        description: t('maintenance.startConfirmDesc', { scope: t(`maintenance.${s}`), desc: t(`maintenance.${s}Desc`) }),
        danger: form.scope !== 'NOTICE',
        confirmText: t('maintenance.startConfirmButton'),
      }))
    )
      return;
    save.mutate({ patch: { enabled: true, autoSchedule: false } });
  };
  const endNow = async () => {
    if (!(await confirm({ title: t('maintenance.endConfirm'), description: t('maintenance.endConfirmDesc'), confirmText: t('maintenance.endNow') }))) return;
    save.mutate({ patch: { enabled: false, autoSchedule: false, updates: [...form.updates.slice(-49), { at: new Date().toISOString(), text: t('maintenance.completed') }] }, extra: { announce: false } });
  };
  const addNote = () => {
    if (!note.trim() || form.updates.length >= 50) return;
    set('updates', [...form.updates, { at: new Date().toISOString(), text: note.trim() }]);
    setNote('');
  };

  // 预览：按表单当前内容，展示“维护中”或“预告”时用户看到的样子
  const previewState = stateOf(form) === 'scheduled' ? 'upcoming' : 'active';
  const { allowEmails: _private, ...publicForm } = form;
  const preview: PublicMaintenance = { ...publicForm, state: previewState, startedAt: form.enabled ? (value.startedAt ?? new Date().toISOString()) : form.startAt, exempt: false };

  return (
    <div className="space-y-4">
      <StatusHero value={value} state={saved} busy={save.isPending} onStart={startNow} onEnd={endNow} />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          <FormCard step={1} title={t('maintenance.activation')} description={t('maintenance.activationHint')}>
            <div className="space-y-4">
              <Segmented
                value={form.autoSchedule ? 'schedule' : 'manual'}
                onChange={(v) => setForm((f) => ({ ...f, autoSchedule: v === 'schedule', enabled: v === 'schedule' ? false : f.enabled }))}
                items={[
                  {
                    value: 'manual',
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        <Hand className="size-3.5" />
                        {t('maintenance.manual')}
                      </span>
                    ),
                  },
                  {
                    value: 'schedule',
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarClock className="size-3.5" />
                        {t('maintenance.schedule')}
                      </span>
                    ),
                  },
                ]}
              />
              {!form.autoSchedule && (
                <div className="flex items-start justify-between gap-4 rounded-lg border border-line px-4 py-3">
                  <div>
                    <div className="text-[13px] font-medium">{t('maintenance.active')}</div>
                    <p className="mt-0.5 text-xs text-fg-3">{t('maintenance.enabledHint')}</p>
                  </div>
                  <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label={form.autoSchedule ? t('maintenance.startAt') : t('maintenance.plannedStart')} required={form.autoSchedule}>
                  <Input type="datetime-local" value={toLocalInput(form.startAt)} onChange={(e) => set('startAt', fromLocalInput(e.target.value))} aria-label={t('maintenance.startAt')} />
                </FormField>
                <FormField label={form.autoSchedule ? t('maintenance.endAt') : t('maintenance.estimatedEnd')} description={form.autoSchedule ? t('maintenance.noEnd') : undefined}>
                  <Input type="datetime-local" value={toLocalInput(form.endAt)} onChange={(e) => set('endAt', fromLocalInput(e.target.value))} aria-label={t('maintenance.endAt')} />
                </FormField>
              </div>
              {form.autoSchedule && (
                <FormField label={t('maintenance.previewHours')} description={t('maintenance.previewHint')}>
                  <InputGroup
                    className="w-28"
                    type="number"
                    min={0}
                    max={168}
                    value={form.previewHours}
                    onChange={(e) => set('previewHours', Math.min(168, Math.max(0, Math.round(Number(e.target.value) || 0))))}
                    suffix={t('maintenance.hoursUnit')}
                  />
                </FormField>
              )}
              {timeError && (
                <p role="alert" className="text-xs text-danger-text">
                  {timeError}
                </p>
              )}
            </div>
          </FormCard>

          <FormCard step={2} title={t('maintenance.scope')} description={t('maintenance.scopeHint')}>
            <div role="radiogroup" aria-label={t('maintenance.scope')} className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
              {SCOPES.map((k) => {
                const s = MAINTENANCE_SCOPES[k];
                const Icon = s.icon;
                const on = form.scope === k;
                const tone = k === 'FULL' ? 'text-danger-text bg-danger-soft' : k === 'READONLY' ? 'text-warning-text bg-warning-soft' : 'text-fg-2 bg-surface-3';
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('scope', k)}
                    className={cn(
                      'flex flex-col gap-2 rounded-lg border p-3.5 text-left transition-[border-color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring',
                      on ? 'border-primary shadow-[0_0_0_1px_var(--color-primary)]' : 'border-line hover:border-line-strong',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn('flex size-7 items-center justify-center rounded-md', tone)}>
                        <Icon className="size-4" />
                      </span>
                      <span className="text-[13.5px] font-medium">{t(`maintenance.${s.key}`)}</span>
                    </span>
                    <span className="text-xs leading-relaxed text-fg-3">{t(`maintenance.${s.key}Desc`)}</span>
                  </button>
                );
              })}
            </div>
          </FormCard>

          <FormCard
            step={3}
            title={t('maintenance.details')}
            description={t('maintenance.detailsHint')}
            extra={
              <div className="hidden gap-1 sm:flex">
                {TEMPLATES.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, title: t(`maintenance.${k}`), message: t(`maintenance.${k}Message`) }))}
                    className="rounded-md px-2 py-1 text-xs text-fg-2 ring-1 ring-line transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    {t(`maintenance.${k}`)}
                  </button>
                ))}
              </div>
            }
          >
            <div className="space-y-4">
              <FormField label={t('maintenance.heading')} required error={titleError}>
                <Input maxLength={80} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={t('maintenance.headingPlaceholder')} />
              </FormField>
              <FormField label={t('maintenance.message')} description={t('maintenance.messageHint', { n: form.message.length })}>
                <Textarea className="text-[13px]" rows={4} maxLength={2000} value={form.message} onChange={(e) => set('message', e.target.value)} />
              </FormField>
            </div>
          </FormCard>

          <FormCard step={4} title={t('maintenance.updates')} description={t('maintenance.updatesHint')}>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addNote();
                    }
                  }}
                  placeholder={t('maintenance.updatePlaceholder')}
                  aria-label={t('maintenance.addUpdate')}
                />
                <Button onClick={addNote} disabled={!note.trim() || form.updates.length >= 50} icon={<Plus />}>
                  {t('maintenance.add')}
                </Button>
              </div>
              {form.updates.length > 0 ? (
                <ol className="ml-1.5 space-y-3 border-l border-line pl-5">
                  {[...form.updates].reverse().map((u) => (
                    <li key={u.at + u.text} className="group relative">
                      <span className="absolute top-1.5 -left-[24.5px] size-2 rounded-full bg-fg-4 ring-2 ring-surface" />
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="tabular text-xs text-fg-3">{formatDate(u.at)}</div>
                          <p className="mt-0.5 text-[13px] whitespace-pre-wrap">{u.text}</p>
                        </div>
                        <button
                          type="button"
                          aria-label={t('maintenance.removeUpdate')}
                          className="rounded p-1 text-fg-4 opacity-0 transition group-hover:opacity-100 hover:bg-danger-soft hover:text-danger-text focus-visible:opacity-100"
                          onClick={() => set('updates', form.updates.filter((x) => x !== u))}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="text-xs text-fg-3">{t('maintenance.noUpdates')}</div>
              )}
            </div>
          </FormCard>

          <FormCard step={5} title={t('maintenance.allowlist')}>
            <div className="space-y-5">
              <FormField
                label={t('maintenance.allowEmails')}
                description={badEmail ? undefined : t('maintenance.allowHint', { n: emailList.length })}
                error={badEmail ? t('maintenance.invalidEmail', { email: badEmail }) : null}
              >
                <Textarea className="font-mono text-xs" rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={'ops@example.com\ntester@example.com'} />
              </FormField>
              <div className="space-y-2 rounded-lg bg-surface-2 px-4 py-3">
                <Checkbox checked={announce} onCheckedChange={setAnnounce} label={t('maintenance.announce')} />
                <div className={cn('pl-6 transition-opacity', !announce && 'pointer-events-none opacity-40')}>
                  <Checkbox checked={announceEmail} onCheckedChange={setAnnounceEmail} disabled={!announce} label={t('maintenance.email')} />
                </div>
              </div>
            </div>
          </FormCard>
        </div>

        <aside className="min-w-0 space-y-4 xl:sticky xl:top-[calc(var(--header-h)+1.5rem)]">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3 text-[15px] font-semibold">{t('maintenance.previewTitle')}</div>
            <div className="border-b border-line bg-surface-2 px-4 py-2 text-xs text-fg-3">
              {previewState === 'upcoming' ? t('maintenance.previewUpcoming') : t('maintenance.previewActive')} · {t('maintenance.bannerPreview')}
            </div>
            <div className="pointer-events-none overflow-hidden [&>[role=status]]:border-t-0">
              <MaintenanceBanner m={preview} />
            </div>
            {form.scope === 'FULL' && previewState === 'active' ? (
              <>
                <div className="border-y border-line bg-surface-2 px-4 py-2 text-xs text-fg-3">{t('maintenance.pagePreview')}</div>
                <div className="pointer-events-none h-72 overflow-hidden" inert>
                  <div className="origin-top-left scale-[0.62] px-4" style={{ width: '161%' }}>
                    <MaintenancePage m={preview} />
                  </div>
                </div>
              </>
            ) : (
              <div className="px-4 py-3 text-xs leading-relaxed text-fg-3">{t(`maintenance.${MAINTENANCE_SCOPES[form.scope].key}Desc`)}</div>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-3 text-xs text-fg-3">{dirty ? t('maintenance.dirty') : t('maintenance.clean')}</div>
            <Button variant="primary" className="w-full" loading={save.isPending} disabled={!dirty || !!timeError || !!titleError || !!badEmail || emailList.length > 100} onClick={() => save.mutate({})}>
              {t('maintenance.saveSettings')}
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                className="mt-2 w-full"
                onClick={() => {
                  setForm(value);
                  setEmails(value.allowEmails.join('\n'));
                  setAnnounce(false);
                }}
              >
                {t('maintenance.discard')}
              </Button>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** 顶部状态卡：当前是否在维护、已持续多久 / 多久后开始，以及快捷开始 / 结束 */
function StatusHero({ value, state, busy, onStart, onEnd }: { value: Form; state: 'active' | 'scheduled' | 'off'; busy: boolean; onStart: () => void; onEnd: () => void }) {
  const t = useT();
  const scope = t(`maintenance.${MAINTENANCE_SCOPES[value.scope].key}`);
  const tone =
    state === 'active'
      ? value.scope === 'FULL'
        ? { ring: 'border-danger/25 bg-danger-soft', dot: 'bg-danger', text: 'text-danger-text' }
        : { ring: 'border-warning-icon/30 bg-warning-soft', dot: 'bg-warning-icon', text: 'text-warning-text' }
      : state === 'scheduled'
        ? { ring: 'border-line bg-surface-2', dot: 'bg-fg-3', text: 'text-fg' }
        : { ring: 'border-line bg-surface', dot: 'bg-success-icon', text: 'text-success-text' };
  const lines = heroLines(t, value, state, scope);
  return (
    <div className={cn('flex flex-wrap items-center gap-4 rounded-lg border px-5 py-4', tone.ring)}>
      <span className="relative flex size-3 shrink-0">
        {state === 'active' && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', tone.dot)} />}
        <span className={cn('relative inline-flex size-3 rounded-full', tone.dot)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[15px] font-semibold', tone.text)}>{state === 'active' ? t('maintenance.active') : state === 'scheduled' ? t('maintenance.scheduled') : t('maintenance.normal')}</div>
        <div className="mt-0.5 truncate text-[13px] text-fg-2">{lines[0]}</div>
        {lines[1] && <div className="mt-0.5 text-xs text-fg-3">{lines[1]}</div>}
      </div>
      {state === 'active' ? (
        <Button variant="primary" loading={busy} icon={<CheckCircle2 />} onClick={onEnd}>
          {t('maintenance.endNow')}
        </Button>
      ) : (
        <Button variant={state === 'scheduled' ? 'secondary' : 'primary'} loading={busy} icon={<Power />} onClick={onStart}>
          {t('maintenance.startNow')}
        </Button>
      )}
    </div>
  );
}

function heroLines(t: TFunction, value: Form, state: 'active' | 'scheduled' | 'off', scope: string): ReactNode[] {
  if (state === 'off') return [t('maintenance.normalDesc'), t('maintenance.normalHint')];
  const head = `${scope} · ${value.title}`;
  if (state === 'active') {
    const startedAt = value.enabled ? value.startedAt : value.startAt;
    if (!startedAt) return [head];
    const end = value.endAt ? t('maintenance.endsAt', { time: formatDate(value.endAt) }) : '';
    return [head, t('maintenance.lasted', { span: spanText(t, Date.now() - Date.parse(startedAt)), time: formatDate(startedAt) }) + end];
  }
  const range = `${formatDate(value.startAt)}${value.endAt ? ` ～ ${formatDate(value.endAt)}` : ''}`;
  const notice = value.previewHours ? t('maintenance.previewOn', { n: value.previewHours }) : t('maintenance.previewOff');
  return [head, t('maintenance.scheduledLine', { when: untilText(t, value.startAt), range }) + notice];
}
