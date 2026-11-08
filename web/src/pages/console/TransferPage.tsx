// 实例转移：新建转移时选择实例，下方是转入 / 转出记录（分类查看，点击查看转移时的实例详情）
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { TransferRecordDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { Badge, Card, Empty, ErrorState } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useInstances } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { dayjs, formatBandwidth, formatCores, formatDate, formatMemory, formatMoney, formatTraffic } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { TransferDialog } from '@/pages/instance/TransferDialog';

type Filter = 'all' | 'IN' | 'OUT';

function DirectionBadge({ r }: { r: TransferRecordDTO }) {
  const { t } = useI18n();
  return r.direction === 'IN' ? (
    <Badge tone="success">
      <ArrowDownLeft className="size-3" />
      {t('transferPage.in')}
    </Badge>
  ) : (
    <Badge>
      <ArrowUpRight className="size-3" />
      {t('transferPage.out')}
    </Badge>
  );
}

/** 详情里的一行：名称 + 值 */
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 text-right break-words text-fg">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-fg-3">{title}</div>
      <div className="divide-y divide-line/70 rounded-md border border-line px-3">{children}</div>
    </div>
  );
}

/** 转移详情：转移时的实例配置、地区、系统、套餐与续费价格，以及转移信息 */
function DetailDialog({ record, onClose }: { record: TransferRecordDTO | null; onClose: () => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const r = record;
  const s = r?.spec;
  return (
    <Modal open={!!r} onOpenChange={(o) => !o && onClose()} size="lg" title={r ? t('transferPage.detailTitle', { name: r.hostname }) : ''} description={t('transferPage.detailDesc')}>
      {r && s && (
        // 两列各自往下排，高度不同的分组不会在下方留出空白；备注较长，单独占一行
        <div className="space-y-3">
          <div className="grid items-start gap-3 md:grid-cols-2">
            <div className="space-y-3">
              <Section title={t('transferPage.secInstance')}>
                <Item label={t('transferPage.hostname')}>
                  {r.accessible ? (
                    <Link to={`/console/instances/${r.instanceId}`} className="font-medium underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                      {r.hostname}
                    </Link>
                  ) : (
                    r.hostname
                  )}
                </Item>
                <Item label={t('transferPage.instanceId')}>
                  <span className="font-mono text-xs">{s.name}</span>
                </Item>
                <Item label={t('common.type')}>{L.instanceType[s.type]}</Item>
                <Item label={t('common.region')}>
                  <span className="inline-flex items-center gap-1.5">
                    {s.country && <CountryFlag code={s.country} className="h-3 w-4.5" />}
                    {s.region}
                  </span>
                </Item>
                <Item label={t('transferPage.image')}>{s.image ?? '—'}</Item>
              </Section>
              <Section title={t('transferPage.secBilling')}>
                <Item label={t('transferPage.product')}>{[s.product, s.plan].filter(Boolean).join(' / ') || '—'}</Item>
                <Item label={t('store.cycle')}>{L.billingCycle[s.cycle]}</Item>
                <Item label={t('transferPage.renewPrice')}>
                  <span className="tabular font-medium">{formatMoney(s.price, currency)}</span>
                  <span className="text-fg-3"> / {L.billingCycle[s.cycle]}</span>
                </Item>
                <Item label={t('transferPage.expiresAt')}>
                  {formatDate(s.expiresAt)}
                  <span className="text-fg-3"> · {t('transferPage.remaining', { n: Math.max(0, dayjs(s.expiresAt).diff(dayjs(r.createdAt), 'day')) })}</span>
                </Item>
              </Section>
            </div>
            <div className="space-y-3">
              <Section title={t('transferPage.secSpec')}>
                <Item label="CPU">{formatCores(s.cpu)}</Item>
                <Item label={t('transferPage.memory')}>{formatMemory(s.memory)}</Item>
                <Item label={t('transferPage.disk')}>{s.disk} GB</Item>
                <Item label={t('transferPage.bandwidth')}>
                  {formatBandwidth(s.bandwidthIn)} / {formatBandwidth(s.bandwidthOut)}
                </Item>
                <Item label={t('transferPage.traffic')}>
                  {formatTraffic(s.traffic)}
                  {s.traffic > 0 && <span className="text-fg-3"> · {L.trafficMode[s.trafficMode]}</span>}
                </Item>
              </Section>
              <Section title={t('transferPage.secTransfer')}>
                <Item label={t('transferPage.counterpart')}>
                  <span className="inline-flex items-center gap-2">
                    <DirectionBadge r={r} />
                    {r.counterpart ?? t('transferPage.byAdmin')}
                  </span>
                </Item>
                <Item label={t('transfer.mode')}>{t(`transfer.mode.${r.mode}`)}</Item>
                {r.direction === 'OUT' && <Item label={t('transfer.fee')}>{Number(r.fee) > 0 ? formatMoney(r.fee, currency) : t('transferPage.noFee')}</Item>}
                <Item label={t('transferPage.time')}>{formatDate(r.createdAt, 'YYYY-MM-DD HH:mm:ss')}</Item>
              </Section>
            </div>
          </div>
          {r.remark && (
            <div className="rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="mr-2 text-fg-3">{t('transfer.remark')}</span>
              <span className="break-words text-fg">{r.remark}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function TransferPage() {
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const currency = useCurrency();
  const instances = useInstances();
  const records = useQuery({
    queryKey: ['transfers'],
    queryFn: () => api.get<TransferRecordDTO[]>('/transfers'),
  });
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [detail, setDetail] = useState<TransferRecordDTO | null>(null);
  const all = records.data ?? [];
  const count = (d: Filter) => (d === 'all' ? all.length : all.filter((r) => r.direction === d).length);
  const rows = filter === 'all' ? all : all.filter((r) => r.direction === filter);
  // 规格摘要：类型 · CPU · 内存 · 硬盘
  const specLine = (r: TransferRecordDTO) => [L.instanceType[r.spec.type], formatCores(r.spec.cpu), formatMemory(r.spec.memory), `${r.spec.disk} GB`].join(' · ');
  const newButton = (
    <Button variant="primary" icon={<Plus />} onClick={() => setOpen(true)}>
      {t('transfer.new')}
    </Button>
  );
  return (
    <>
      <PageHeader title={t('nav.transfer')} description={t('transferPage.desc')} actions={newButton} />
      <TabBar<Filter>
        value={filter}
        onChange={setFilter}
        className="mb-4"
        items={(['all', 'OUT', 'IN'] as const).map((v) => ({
          value: v,
          label: `${v === 'all' ? t('transferPage.all') : v === 'IN' ? t('transferPage.in') : t('transferPage.out')}${records.data ? ` ${count(v)}` : ''}`,
        }))}
      />
      {records.error ? (
        <ErrorState error={records.error} onRetry={() => records.refetch()} />
      ) : (
        <Card className="overflow-hidden">
          <DataTable
            rows={records.data ? rows : undefined}
            loading={records.isLoading}
            rowKey={(r) => r.id}
            empty={
              <Empty
                title={filter === 'all' ? t('transferPage.empty') : filter === 'IN' ? t('transferPage.emptyIn') : t('transferPage.emptyOut')}
                description={filter === 'all' ? t('transferPage.emptyDesc') : undefined}
                icon={<ArrowRightLeft />}
                action={filter === 'all' ? newButton : undefined}
              />
            }
            columns={[
              {
                key: 'instance',
                header: t('nav.instances'),
                mobile: 'title',
                cell: (r) => (
                  <span className="block min-w-0 leading-tight">
                    <span className="flex items-center gap-1.5">
                      {r.spec.country && <CountryFlag code={r.spec.country} className="h-2.5 w-3.5 shrink-0" />}
                      {r.accessible ? (
                        <Link to={`/console/instances/${r.instanceId}`} className="truncate font-mono text-[13px] font-medium text-fg hover:underline hover:underline-offset-4">
                          {r.hostname}
                        </Link>
                      ) : (
                        <span className="truncate font-mono text-[13px] font-medium text-fg-2">{r.hostname}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-3">{specLine(r)}</span>
                  </span>
                ),
              },
              ...(filter === 'all'
                ? [
                    {
                      key: 'direction',
                      header: t('transferPage.direction'),
                      cell: (r: TransferRecordDTO) => <DirectionBadge r={r} />,
                    },
                  ]
                : []),
              {
                key: 'counterpart',
                header: t('transferPage.counterpart'),
                cell: (r) => (r.counterpart ? <span className="text-fg">{r.counterpart}</span> : <span className="text-fg-3">{t('transferPage.byAdmin')}</span>),
              },
              {
                key: 'mode',
                header: t('transfer.mode'),
                cell: (r) => <span className="text-fg-2">{t(`transfer.mode.${r.mode}`)}</span>,
              },
              {
                key: 'price',
                header: t('transferPage.renewPrice'),
                cell: (r) => (
                  <span className="tabular whitespace-nowrap">
                    <span className="font-medium text-fg">{formatMoney(r.spec.price, currency)}</span>
                    <span className="text-xs text-fg-3"> / {L.billingCycle[r.spec.cycle]}</span>
                  </span>
                ),
              },
              ...(filter !== 'IN'
                ? [
                    {
                      key: 'fee',
                      header: t('transfer.fee'),
                      cell: (r: TransferRecordDTO) =>
                        r.direction === 'OUT' && Number(r.fee) > 0 ? <span className="tabular text-fg">{formatMoney(r.fee, currency)}</span> : <span className="text-fg-4">—</span>,
                    },
                  ]
                : []),
              {
                key: 'remark',
                header: t('transfer.remark'),
                mobile: 'full',
                cell: (r) =>
                  r.remark ? (
                    <span className="block max-w-xs truncate text-[13px] text-fg-2" title={r.remark}>
                      {r.remark}
                    </span>
                  ) : (
                    <span className="text-fg-4">—</span>
                  ),
              },
              {
                key: 'time',
                header: t('transferPage.time'),
                cell: (r) => <span className="tabular whitespace-nowrap text-fg-2">{formatDate(r.createdAt)}</span>,
              },
              {
                key: 'actions',
                header: '',
                mobile: 'actions',
                cell: (r) => (
                  <Button size="sm" onClick={() => setDetail(r)}>
                    {t('transferPage.detail')}
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}
      <DetailDialog record={detail} onClose={() => setDetail(null)} />
      <TransferDialog
        instances={(instances.data ?? []).filter((i) => i.status !== 'DELETED')}
        open={open}
        onClose={() => setOpen(false)}
        // 留在本页：刷新记录和实例列表
        onDone={() => {
          void qc.invalidateQueries({ queryKey: ['transfers'] });
          void qc.invalidateQueries({ queryKey: ['instances'] });
        }}
      />
    </>
  );
}
