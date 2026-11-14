import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Pencil, Plus, Radar, RefreshCw, Server, Trash } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { PING_ISPS, PING_REGIONS, pingRegionNeedsIsp, type AdminPingSettingsDTO, type ManagedPingTarget } from '../../shared/index';
import { AdminNodeTestButton } from '@/components/ping/NodeTestButton';
import { PageHeader, Toolbar } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Badge, Card, CardBody, Empty, ErrorState, PageLoading, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n, useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

function useRefreshPing() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['admin-ping', 'admin-node-ping', 'product-ping', 'admin-nodes', 'admin-node']) void qc.invalidateQueries({ queryKey: [key] });
  };
}

function Schedule({ data }: { data: AdminPingSettingsDTO }) {
  const t = useT();
  const refresh = useRefreshPing();
  const [minutes, setMinutes] = useState(data.interval / 60);
  const [count, setCount] = useState(data.count);
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; interval?: number; count?: number }) => api.patch('/admin/ping', body),
    onSuccess: () => { refresh(); toast.success(t('common.saved')); }, onError: err => toast.fromError(err),
  });
  return <Card className="mb-4"><CardBody className="space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-sm font-semibold text-fg">{t('probe.enabled')}</h2><p className="mt-1 max-w-3xl text-xs leading-relaxed text-fg-3">{t('probe.scheduleHint')}</p></div>
      <Switch checked={data.enabled} disabled={save.isPending} onCheckedChange={enabled => save.mutate({ enabled })} label={<span className="sr-only">{t('probe.enabled')}</span>} />
    </div>
    <form onSubmit={e => { e.preventDefault(); if (!save.isPending) save.mutate({ interval: Math.round(minutes * 60), count }); }} className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
      <FormField label={t('probe.interval')} className="w-40"><Input required type="number" min={10} max={1440} step={1} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></FormField>
      <FormField label={t('probe.count')} className="w-36"><Input required type="number" min={1} max={10} step={1} value={count} onChange={e => setCount(Number(e.target.value))} /></FormField>
      <Button type="submit" loading={save.isPending} disabled={minutes * 60 === data.interval && count === data.count}>{t('common.save')}</Button>
      <span className="pb-2 text-xs text-fg-3">{t('probe.activeCounts', { targets: data.targets.filter(target => target.enabled).length, objects: data.objects.filter(node => node.enabled).length })}</span>
    </form>
  </CardBody></Card>;
}

function TargetEditor({ item, onClose }: { item?: ManagedPingTarget; onClose: () => void }) {
  const { t, locale } = useI18n();
  const refresh = useRefreshPing();
  const [form, setForm] = useState({ name: item?.name ?? '', host: item?.host ?? '', port: item?.port ?? 80, province: item?.province ?? '北京', isp: item?.isp ?? 'CT', enabled: item?.enabled ?? true });
  const needsIsp = pingRegionNeedsIsp(form.province);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(current => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, isp: needsIsp ? form.isp : null };
      return item ? api.patch(`/admin/ping/targets/${item.id}`, body) : api.post('/admin/ping/targets', body);
    },
    onSuccess: () => { refresh(); toast.success(t('common.saved')); onClose(); }, onError: err => setError(errorText(err)),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!save.isPending) save.mutate(); };
  return <Modal open title={t(item ? 'probe.editTarget' : 'probe.addTarget')} onOpenChange={open => !open && !save.isPending && onClose()} footer={<>
    <Button disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" form="ping-target-editor" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
  </>}>
    <form id="ping-target-editor" onSubmit={submit} className="space-y-4">
      <FormField label={t('probe.name')}><Input maxLength={80} value={form.name} placeholder={t(needsIsp ? 'probe.nameHint' : 'probe.regionNameHint')} onChange={e => set('name', e.target.value)} /></FormField>
      <div className="grid gap-4 sm:grid-cols-[1fr_100px]">
        <FormField required label={t('probe.host')} description={t('probe.hostHint')}><Input required maxLength={253} value={form.host} placeholder="ping.example.com" onChange={e => set('host', e.target.value)} /></FormField>
        <FormField required label={t('probe.port')}><Input required type="number" min={1} max={65535} value={form.port} onChange={e => set('port', Number(e.target.value))} /></FormField>
      </div>
      <div className={cn('grid gap-4', needsIsp && 'grid-cols-2')}>
        <FormField label={t('probe.province')}><Select aria-label={t('probe.province')} value={form.province} onChange={value => set('province', value)} options={PING_REGIONS.map(([, zh, en]) => ({ value: zh, label: locale === 'en' ? en : zh }))} /></FormField>
        {needsIsp && <FormField required label={t('ping.col.isp')}><Select aria-label={t('ping.col.isp')} value={form.isp} onChange={value => set('isp', value)} options={PING_ISPS.map(isp => ({ value: isp, label: t(`ping.isp.${isp}`) }))} /></FormField>}
      </div>
      <Switch checked={form.enabled} onCheckedChange={value => set('enabled', value)} label={t('probe.targetEnabled')} />
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  </Modal>;
}

function AddObject({ data, onClose }: { data: AdminPingSettingsDTO; onClose: () => void }) {
  const t = useT();
  const refresh = useRefreshPing();
  const [id, setId] = useState(data.available[0]?.id ?? 0);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post('/admin/ping/objects', { nodeId: id }),
    onSuccess: () => { refresh(); toast.success(t('common.saved')); onClose(); }, onError: err => setError(errorText(err)),
  });
  return <Modal open title={t('probe.addObject')} onOpenChange={open => !open && !save.isPending && onClose()} footer={<>
    <Button disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!id || !data.available.some(node => node.id === id)} loading={save.isPending} onClick={() => save.mutate()}>{t('common.add')}</Button>
  </>}>
    <div className="space-y-4"><p className="text-sm text-fg-3">{t('probe.objectHint')}</p>
      {data.available.length ? <FormField label={t('probe.object')}><Select<number> aria-label={t('probe.object')} value={id} onChange={setId} options={data.available.map(node => ({ value: node.id, label: node.name, description: `${node.region} · ${t(node.online ? 'probe.online' : 'probe.offline')}` }))} /></FormField> : <Empty icon={<Server />} title={t('probe.noAvailable')} />}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  </Modal>;
}

export default function PingSettings() {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const refresh = useRefreshPing();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'objects' ? 'objects' : 'targets';
  const [editing, setEditing] = useState<ManagedPingTarget | 'new' | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [isp, setIsp] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const targetsId = useId();
  const q = useQuery({ queryKey: ['admin-ping'], queryFn: () => api.get<AdminPingSettingsDTO>('/admin/ping'), refetchInterval: 30_000 });
  const change = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api.patch(`/admin/ping/${path}`, body),
    onSuccess: refresh, onError: err => toast.fromError(err),
  });
  const remove = useMutation({ mutationFn: (path: string) => api.delete(`/admin/ping/${path}`), onSuccess: refresh, onError: err => toast.fromError(err) });
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading />;
  const data = q.data;
  const rows = data.targets.filter(target => (isp === 'all' || (isp === 'none' ? target.isp === null : target.isp === isp)) && `${target.name ?? ''} ${target.host} ${target.province} ${target.provinceEn}`.toLowerCase().includes(search.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  return <>
    <PageHeader title={t('nav.admin.ping')} description={t('probe.subtitle')} actions={<>
      <Button icon={<RefreshCw />} loading={q.isFetching} onClick={refresh}>{t('common.refresh')}</Button>
      <Button variant="primary" icon={<Plus />} onClick={() => tab === 'targets' ? setEditing('new') : setAdding(true)}>{t(tab === 'targets' ? 'probe.addTarget' : 'probe.addObject')}</Button>
    </>} />
    <Schedule key={`${data.interval}-${data.count}`} data={data} />
    <TabBar<'targets' | 'objects'> value={tab} onChange={value => setParams(value === 'targets' ? {} : { tab: value }, { replace: true })} className="mb-4" items={[
      { value: 'targets', label: t('probe.targets'), count: data.targets.length, icon: <Radar /> },
      { value: 'objects', label: t('probe.objects'), count: data.objects.length, icon: <Server /> },
    ]} />
    {tab === 'targets' ? <Card>
      <button
        type="button"
        aria-expanded={targetsOpen}
        aria-controls={targetsId}
        aria-label={t(targetsOpen ? 'probe.collapseTargets' : 'probe.expandTargets')}
        onClick={() => setTargetsOpen(open => !open)}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring sm:px-5"
      >
        <span className="flex min-w-0 items-center gap-3">
          <Radar className="size-4 shrink-0 text-fg-3" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-fg">{t('probe.targets')}</span>
            <span className="mt-0.5 block text-xs text-fg-3">{t('probe.targetsSummary', { total: data.targets.length, enabled: data.targets.filter(target => target.enabled).length })}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-fg-3">
          <span className="hidden sm:inline">{t(targetsOpen ? 'probe.collapseTargets' : 'probe.expandTargets')}</span>
          <ChevronDown className={cn('size-4 transition-transform duration-200', !targetsOpen && '-rotate-90')} />
        </span>
      </button>
      <div id={targetsId} role="region" aria-label={t('probe.targets')} aria-hidden={!targetsOpen} inert={!targetsOpen} className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-smooth', targetsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-line">
            <Toolbar><Input aria-label={t('probe.search')} placeholder={t('probe.search')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="sm:max-w-xs" /><Select aria-label={t('ping.col.isp')} value={isp} onChange={value => { setIsp(value); setPage(1); }} className="sm:w-40" options={[{ value: 'all', label: t('ping.all') }, ...PING_ISPS.map(isp => ({ value: isp, label: t(`ping.isp.${isp}`) })), { value: 'none', label: t('ping.noIsp') }]} /><span className="text-xs text-fg-3">{t('probe.targetsHint')}</span></Toolbar>
            <DataTable rows={rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)} refreshing={q.isFetching} rowKey={target => target.id} empty={<Empty icon={<Radar />} title={t('probe.noTargets')} />} columns={[
              { key: 'name', header: t('probe.target'), cell: target => <div><span className="font-medium text-fg">{target.name || [locale === 'en' ? target.provinceEn : target.province, target.isp && t(`ping.isp.${target.isp}`)].filter(Boolean).join(' · ')}</span><div className="mt-0.5 break-all font-mono text-xs text-fg-3">{target.host}:{target.port}</div></div> },
              { key: 'province', header: t('probe.province'), cell: target => locale === 'en' ? target.provinceEn : target.province },
              { key: 'isp', header: t('ping.col.isp'), cell: target => target.isp ? t(`ping.isp.${target.isp}`) : '—' },
              { key: 'enabled', header: t('common.status'), cell: target => <Switch checked={target.enabled} disabled={change.isPending} label={<span className="sr-only">{t('probe.toggleTarget', { name: target.name || target.host })}</span>} onCheckedChange={enabled => change.mutate({ path: `targets/${target.id}`, body: { ...target, enabled } })} /> },
              { key: 'actions', header: t('common.actions'), cell: target => <div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setEditing(target)}><Pencil /></Button><Button size="icon-sm" variant="danger-ghost" aria-label={t('common.delete')} disabled={remove.isPending} onClick={async () => { if (await confirm({ title: t('probe.deleteTarget', { name: target.name || target.host }), description: t('probe.deleteTargetHint'), danger: true })) remove.mutate(`targets/${target.id}`); }}><Trash /></Button></div> },
            ]} />
            <Pagination page={currentPage} pageSize={pageSize} total={rows.length} onChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} pageSizes={[20, 50, 100, 200]} />
          </div>
        </div>
      </div>
    </Card> : <Card><DataTable rows={data.objects} refreshing={q.isFetching} rowKey={node => node.id} empty={<Empty icon={<Server />} title={t('probe.noObjects')} description={t('probe.objectHint')} />} columns={[
      { key: 'name', header: t('probe.object'), cell: node => <div><span className="font-medium text-fg">{node.name}</span><p className="mt-0.5 text-xs text-fg-3">{node.region}</p></div> },
      { key: 'online', header: t('probe.agentStatus'), cell: node => <div className="flex flex-wrap gap-1"><Badge tone={node.online ? 'success' : 'neutral'}>{t(node.online ? 'probe.online' : 'probe.offline')}</Badge>{!node.nodeEnabled && <Badge tone="warning">{t('probe.nodeDisabled')}</Badge>}</div> },
      { key: 'tested', header: t('probe.lastTest'), cell: node => <span className="text-xs text-fg-3">{node.testedAt ? formatDate(node.testedAt) : t('probe.notTested')}</span> },
      { key: 'enabled', header: t('probe.objectEnabled'), cell: node => <div className="flex items-center gap-2"><Switch checked={node.enabled} disabled={change.isPending} label={<span className="sr-only">{t('probe.toggleObject', { name: node.name })}</span>} onCheckedChange={enabled => change.mutate({ path: `objects/${node.id}`, body: { enabled } })} />{node.enabled && !data.enabled && <span className="text-xs text-fg-3">{t('probe.paused')}</span>}</div> },
      { key: 'actions', header: t('common.actions'), mobile: 'full', cell: node => <div className="flex flex-wrap gap-1 md:justify-end"><AdminNodeTestButton nodeId={node.id} nodeName={node.name} /><Button size="icon-sm" variant="danger-ghost" disabled={remove.isPending} aria-label={t('probe.removeObject')} onClick={async () => { if (await confirm({ title: t('probe.deleteObject', { name: node.name }), description: t('probe.deleteObjectHint'), danger: true, confirmText: t('probe.removeObject') })) remove.mutate(`objects/${node.id}`); }}><Trash /></Button></div> },
    ]} /></Card>}
    {editing && <TargetEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    {adding && <AddObject data={data} onClose={() => setAdding(false)} />}
  </>;
}
