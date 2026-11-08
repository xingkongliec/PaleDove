// 管理后台 → 实名认证：支付宝身份验证的应用配置、认证记录（认证中 / 已通过 / 未通过）、查看完整信息与撤销认证
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Clock, IdCard, PlugZap, Search, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { Paginated, VerificationStatus } from '../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, Empty, InfoList, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { Segmented } from '@/components/ui/tabs';
import { useI18n, useT, type TFunction } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

interface Row {
  id: number;
  userId: number;
  nameMasked: string;
  idNumberMasked: string;
  status: VerificationStatus;
  reason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  user: { id: number; email: string; username: string };
}
interface Detail extends Row {
  realName: string;
  idNumber: string;
  user: Row['user'] & { createdAt: string };
}

const STATUS_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger' } as const;
const QUICK_REASONS = ['realnameAdmin.quick1', 'realnameAdmin.quick2', 'realnameAdmin.quick3'] as const;

/** 由身份证号推出出生日期、年龄、性别（仅用于展示，不保存） */
function idFacts(id: string, t: TFunction) {
  const birth = `${id.slice(6, 10)}-${id.slice(10, 12)}-${id.slice(12, 14)}`;
  const age = Math.floor((Date.now() - Date.parse(birth)) / (365.25 * 86_400_000));
  const gender = Number(id[16]) % 2 ? t('realnameAdmin.male') : t('realnameAdmin.female');
  return { birth, age, gender };
}

export default function AdminRealname() {
  const { t, L } = useI18n();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<VerificationStatus | ''>('');
  const list = useQuery({
    queryKey: ['admin-realname', page, q, status],
    queryFn: () => api.get<Paginated<Row> & { counts: Partial<Record<VerificationStatus, number>> }>('/admin/realname', { page, pageSize: 20, q, status: status || undefined }),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState<number | null>(null);
  const counts = list.data?.counts ?? {};
  const count = (n?: number) => <span className="text-xs text-fg-3 tabular-nums">{n ?? 0}</span>;
  return (
    <div>
      <PageHeader title={t('nav.admin.realname')} description={t('realnameAdmin.subtitle')} />
      <AlipayCard />
      <Card>
        <Toolbar>
          <Segmented
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            items={[
              { value: '' as const, label: t('realnameAdmin.all') },
              { value: 'APPROVED' as const, label: <>{L.verificationStatus.APPROVED} {count(counts.APPROVED)}</> },
              { value: 'PENDING' as const, label: <>{L.verificationStatus.PENDING} {count(counts.PENDING)}</> },
              { value: 'REJECTED' as const, label: <>{L.verificationStatus.REJECTED} {count(counts.REJECTED)}</> },
            ]}
          />
          <div className="relative min-w-0 sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <Input
              className="pl-9"
              placeholder={t('realnameAdmin.search')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </Toolbar>
        <DataTable
          loading={list.isLoading}
          rows={list.data?.items}
          rowKey={(r) => r.id}
          empty={<Empty icon={<IdCard />} title={t('realnameAdmin.empty')} />}
          columns={[
            {
              key: 'user',
              header: t('common.user'),
              cell: (r) => (
                <div>
                  <div className="font-medium">{r.user.username}</div>
                  <div className="text-xs text-fg-3">{r.user.email}</div>
                </div>
              ),
            },
            {
              key: 'info',
              header: t('realnameAdmin.info'),
              cell: (r) => (
                <span className="text-[13px]" translate="no">
                  {r.nameMasked} <span className="font-mono text-xs text-fg-3">{r.idNumberMasked}</span>
                </span>
              ),
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (r) => (
                <Badge tone={STATUS_TONE[r.status]} dot>
                  {L.verificationStatus[r.status]}
                </Badge>
              ),
            },
            {
              key: 'reason',
              header: t('realnameAdmin.reason'),
              cell: (r) =>
                r.reason ? (
                  <span className="block max-w-56 truncate text-xs text-danger-text" title={r.reason}>
                    {r.reason}
                  </span>
                ) : (
                  <span className="text-fg-3">-</span>
                ),
            },
            {
              key: 'time',
              header: t('realnameAdmin.time'),
              cell: (r) => (
                <span className="text-xs tabular-nums">
                  {formatDate(r.submittedAt)}
                  <div className="text-fg-3">{formatDate(r.reviewedAt)}</div>
                </span>
              ),
            },
            {
              key: 'actions',
              header: '',
              className: 'text-right',
              cell: (r) => (
                <Button size="sm" onClick={() => setOpen(r.id)}>
                  {t('realnameAdmin.view')}
                </Button>
              ),
            },
          ]}
        />
        {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
      </Card>
      <DetailDialog id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

type BizCode = 'FACE' | 'CERT_PHOTO' | 'CERT_PHOTO_FACE' | 'SMART_FACE';
interface AlipaySettings {
  enabled: boolean;
  appId: string;
  hasPrivateKey: boolean;
  alipayPublicKey: string;
  gateway: string;
  bizCode: BizCode;
  returnUrl: string;
}

/** 支付宝开放平台「身份验证」应用配置 */
function AlipayCard() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['realname-settings'], queryFn: () => api.get<AlipaySettings>('/admin/realname-settings') });
  const [form, setForm] = useState<(AlipaySettings & { privateKey: string }) | null>(null);
  const [open, setOpen] = useState(false);
  const bizCodes: Array<{ value: BizCode; label: string }> = [
    { value: 'FACE', label: t('realnameAdmin.bizFace') },
    { value: 'SMART_FACE', label: t('realnameAdmin.bizSmartFace') },
    { value: 'CERT_PHOTO_FACE', label: t('realnameAdmin.bizCertPhotoFace') },
    { value: 'CERT_PHOTO', label: t('realnameAdmin.bizCertPhoto') },
  ];
  const save = useMutation({
    mutationFn: (f: AlipaySettings & { privateKey: string }) =>
      api.put<AlipaySettings>('/admin/realname-settings', {
        enabled: f.enabled,
        appId: f.appId.trim(),
        privateKey: f.privateKey.trim() || undefined,
        alipayPublicKey: f.alipayPublicKey.trim(),
        gateway: f.gateway.trim(),
        bizCode: f.bizCode,
      }),
    onSuccess: (r) => {
      qc.setQueryData(['realname-settings'], r);
      setForm(null);
      toast.success(t('realnameAdmin.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ message: string }>('/admin/realname-settings/test'),
    onSuccess: (r) => toast.success(r.message),
    onError: (e) => toast.fromError(e),
  });
  const data = q.data;
  if (!data) return <div className="skeleton fade-in-delay mb-4 h-24 rounded-lg" />;
  const f = form ?? { ...data, privateKey: '' };
  const set = (p: Partial<typeof f>) => setForm({ ...f, ...p });
  const ready = data.enabled && data.appId && data.hasPrivateKey && data.alipayPublicKey;
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', ready ? 'bg-success-soft text-success-text' : 'bg-surface-3 text-fg-3')}>
          <BadgeCheck className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            {t('realnameAdmin.alipayTitle')}
            <span className={cn('rounded px-1.5 py-px text-[11px] font-medium', ready ? 'bg-success-soft text-success-text' : 'bg-surface-3 text-fg-2')}>
              {ready ? t('realnameAdmin.enabled') : data.enabled ? t('realnameAdmin.incomplete') : t('realnameAdmin.disabled')}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-fg-3">
            {ready ? `APPID ${data.appId} · ${bizCodes.find((b) => b.value === data.bizCode)?.label ?? data.bizCode}` : t('realnameAdmin.alipayIntro')}
          </p>
        </div>
        <div className="flex gap-2">
          {data.hasPrivateKey && (
            <Button icon={<PlugZap className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>
              {t('realnameAdmin.test')}
            </Button>
          )}
          <Button variant={open ? 'secondary' : 'primary'} onClick={() => setOpen(!open)}>
            {open ? t('realnameAdmin.collapse') : t('realnameAdmin.configure')}
          </Button>
        </div>
      </div>
      {open && (
        <div className="space-y-4 border-t border-line px-5 py-5">
          <div className="flex items-center justify-between gap-4 rounded-lg bg-surface-2 px-4 py-3">
            <div>
              <div className="text-[13px] font-medium">{t('realnameAdmin.enable')}</div>
              <div className="mt-0.5 text-xs text-fg-3">{t('realnameAdmin.enableHint')}</div>
            </div>
            <Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="APPID" required>
              <Input className="font-mono" value={f.appId} onChange={(e) => set({ appId: e.target.value.replace(/\D/g, '') })} placeholder="2021000000000000" />
            </FormField>
            <FormField label={t('realnameAdmin.bizCode')}>
              <Select value={f.bizCode} onChange={(v) => set({ bizCode: v })} options={bizCodes} />
            </FormField>
          </div>
          <FormField label={t('realnameAdmin.privateKey')} required description={data.hasPrivateKey ? t('realnameAdmin.keyKeep') : t('realnameAdmin.privateKeyHint')}>
            <Textarea
              className="font-mono text-xs"
              rows={4}
              value={f.privateKey}
              onChange={(e) => set({ privateKey: e.target.value })}
              placeholder={data.hasPrivateKey ? t('realnameAdmin.keyConfigured') : 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...'}
            />
          </FormField>
          <FormField label={t('realnameAdmin.alipayPublicKey')} required description={t('realnameAdmin.alipayPublicKeyHint')}>
            <Textarea className="font-mono text-xs" rows={3} value={f.alipayPublicKey} onChange={(e) => set({ alipayPublicKey: e.target.value })} placeholder="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..." />
          </FormField>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label={t('realnameAdmin.gateway')} description={t('realnameAdmin.gatewayHint')}>
              <Input className="font-mono" value={f.gateway} onChange={(e) => set({ gateway: e.target.value })} />
            </FormField>
            <FormField label={t('realnameAdmin.returnUrl')} description={t('realnameAdmin.returnUrlHint')}>
              <Input className="font-mono" value={data.returnUrl} readOnly />
            </FormField>
          </div>
          <div className="flex justify-end gap-2">
            {form && <Button onClick={() => setForm(null)}>{t('realnameAdmin.reset')}</Button>}
            <Button variant="primary" disabled={!form} loading={save.isPending} onClick={() => save.mutate(f)}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function DetailDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-realname-detail', id], queryFn: () => api.get<Detail>(`/admin/realname/${id}`), enabled: id !== null, gcTime: 0 });
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: () => api.post(`/admin/realname/${id}/revoke`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success(t('realnameAdmin.revoked'));
      setReason('');
      onClose();
      void qc.invalidateQueries({ queryKey: ['admin-realname'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const d = id !== null ? q.data : undefined;
  const facts = d && /^\d{17}[\dX]$/.test(d.idNumber) ? idFacts(d.idNumber, t) : null;
  const Icon = d?.status === 'APPROVED' ? BadgeCheck : d?.status === 'REJECTED' ? ShieldAlert : Clock;
  return (
    <Modal
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          onClose();
        }
      }}
      title={t('realnameAdmin.detailTitle')}
      footer={
        d && (
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            {d.status === 'APPROVED' && (
              <Button
                variant="danger"
                loading={revoke.isPending}
                onClick={() => (reason.trim() ? revoke.mutate() : toast.error(t('realnameAdmin.reasonRequired')))}
              >
                {t('realnameAdmin.revoke')}
              </Button>
            )}
          </>
        )
      }
    >
      {!d ? (
        <div className="skeleton fade-in-delay h-40 rounded-lg" />
      ) : (
        <div className="space-y-4">
          <div
            className={cn(
              'flex items-center gap-3 rounded-lg px-4 py-3',
              d.status === 'APPROVED' ? 'bg-success-soft text-success-text' : d.status === 'REJECTED' ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
            )}
          >
            <Icon className="size-5 shrink-0" />
            <div className="text-[13px]">
              <b>{L.verificationStatus[d.status]}</b>
              {d.reviewedAt && <span className="ml-2 opacity-80">{formatDate(d.reviewedAt)}</span>}
              {d.reason && <div className="mt-0.5 text-xs opacity-90">{t('realnameAdmin.reasonLine', { reason: d.reason })}</div>}
            </div>
          </div>
          <InfoList
            items={[
              { label: t('common.user'), value: `${d.user.username}（${d.user.email}）` },
              { label: t('account.registeredAt'), value: formatDate(d.user.createdAt) },
              {
                label: t('realname.realName'),
                value: (
                  <span className="text-[15px] font-semibold" translate="no">
                    {d.realName}
                  </span>
                ),
              },
              {
                label: t('realname.idNumber'),
                value: (
                  <span className="font-mono text-[14px] tracking-wide" translate="no">
                    {d.idNumber}
                  </span>
                ),
              },
              { label: t('realnameAdmin.facts'), value: facts ? t('realnameAdmin.factsValue', { birth: facts.birth, age: facts.age, gender: facts.gender }) : '-' },
              { label: t('realnameAdmin.submittedAt'), value: formatDate(d.submittedAt) },
            ]}
          />
          {d.status === 'APPROVED' && (
            <FormField label={t('realnameAdmin.revokeReason')}>
              <div className="space-y-2">
                <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t('realnameAdmin.revokePlaceholder')} />
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_REASONS.map((k) => (
                    <button key={k} type="button" onClick={() => setReason(t(k))} className="rounded-md px-2 py-0.5 text-xs text-fg-2 ring-1 ring-line hover:bg-surface-2 hover:text-fg">
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
            </FormField>
          )}
          <Alert tone="neutral">{t('realnameAdmin.viewLogged')}</Alert>
        </div>
      )}
    </Modal>
  );
}
