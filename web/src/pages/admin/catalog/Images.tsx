import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Disc3, ListPlus, Pencil, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import { IMAGE_ARCHES, presetsFor, presetSortOrder, type AdminImageDTO, type ImageArch } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { OsIcon } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Badge, Card, Checkbox, Empty, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

function ImageDialog({ image, arch, onClose }: { image?: AdminImageDTO; arch: ImageArch; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: image?.name ?? '',
    family: image?.family ?? 'debian',
    alias: image?.alias ?? '',
    server: image?.server ?? 'https://images.linuxcontainers.org',
    protocol: (image?.protocol ?? 'simplestreams') as 'simplestreams' | 'incus' | 'oci',
    forContainer: image?.forContainer ?? true,
    forVm: image?.forVm ?? true,
    arch: image?.arch ?? arch,
    cloudInit: image?.cloudInit ?? '',
    enabled: image?.enabled ?? true,
    sortOrder: String(image?.sortOrder ?? 0),
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, sortOrder: Number(f.sortOrder), cloudInit: f.cloudInit || null };
      return image ? api.patch(`/admin/images/${image.id}`, body) : api.post('/admin/images', body);
    },
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['admin-images'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={image ? t('images.edit') : t('images.add')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('images.name')} required>
            <Input value={f.name} onChange={set('name')} placeholder="Debian 12" />
          </FormField>
          <FormField label={t('images.family')} description={t('images.familyHint')}>
            <Input value={f.family} onChange={set('family')} />
          </FormField>
          <FormField label={t('images.alias')} required description={t('images.aliasHint')}>
            <Input value={f.alias} onChange={set('alias')} className="font-mono text-xs" placeholder="debian/12/cloud" />
          </FormField>
          <FormField label={t('images.protocol')}>
            <Select
              value={f.protocol}
              onChange={(v) => setF({ ...f, protocol: v })}
              options={[
                { value: 'simplestreams', label: 'simplestreams' },
                { value: 'incus', label: 'incus' },
                { value: 'oci', label: 'oci' },
              ]}
            />
          </FormField>
          <FormField label={t('images.arch')}>
            <Select
              value={f.arch}
              onChange={(v) => setF({ ...f, arch: v })}
              options={IMAGE_ARCHES.map((a) => ({ value: a, label: a, description: t(`images.archDesc.${a}`) }))}
            />
          </FormField>
          <FormField label={t('images.server')}>
            <Input value={f.server} onChange={set('server')} className="font-mono text-xs" />
          </FormField>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox checked={f.forContainer} onCheckedChange={(v) => setF({ ...f, forContainer: v })} label={t('images.forContainer')} />
          <Checkbox checked={f.forVm} onCheckedChange={(v) => setF({ ...f, forVm: v })} label={t('images.forVm')} />
          <Switch checked={f.enabled} onCheckedChange={(v) => setF({ ...f, enabled: v })} label={t('common.enable')} />
        </div>
        <FormField label={`${t('images.cloudInit')}${t('common.optionalSuffix')}`} description={t('images.cloudInitHint')}>
          <Textarea rows={6} className="font-mono text-xs" value={f.cloudInit} onChange={set('cloudInit')} placeholder="#cloud-config" />
        </FormField>
        <FormField label={t('common.sortOrder')}>
          <Input type="number" value={f.sortOrder} onChange={set('sortOrder')} className="w-32" />
        </FormField>
      </div>
    </Modal>
  );
}

/** 添加常用镜像：列出官方镜像源里核对过的常用发行版，已添加的（按别名）不能重复勾选 */
function PresetDialog({ existing, arch, onClose }: { existing: AdminImageDTO[]; arch: ImageArch; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  // 同一个别名可以分别添加 x86_64 与 aarch64 两份
  const have = new Set(existing.filter((i) => i.arch === arch).map((i) => i.alias));
  const presets = presetsFor(arch);
  const available = presets.filter((p) => !have.has(p.alias));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(available.map((p) => p.alias)));
  const toggle = (alias: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(alias);
      else next.delete(alias);
      return next;
    });
  const add = useMutation({
    mutationFn: async () => {
      // 按常用镜像列表的位置排序：新加的镜像插到同系列旁边，而不是排在最后
      for (const p of presets.filter((x) => picked.has(x.alias))) {
        await api.post('/admin/images', { name: p.name, family: p.family, alias: p.alias, arch, forContainer: true, forVm: p.forVm, sortOrder: presetSortOrder(p.alias) });
      }
    },
    onSuccess: () => {
      toast.success(t('images.presetAdded', { n: picked.size }));
      void qc.invalidateQueries({ queryKey: ['admin-images'] });
      onClose();
    },
    onError: (e) => {
      toast.fromError(e);
      void qc.invalidateQueries({ queryKey: ['admin-images'] });
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t('images.presetTitleArch', { arch })}
      description={t('images.presetDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={add.isPending} disabled={picked.size === 0} onClick={() => add.mutate()}>
            {t('images.presetSubmit', { n: picked.size })}
          </Button>
        </>
      }
    >
      <div className="grid gap-1.5 sm:grid-cols-2">
        {presets.map((p) => {
          const added = have.has(p.alias);
          return (
            <label
              key={p.alias}
              className={cn('flex items-center gap-2.5 rounded-md border border-line px-3 py-2', added ? 'opacity-60' : 'cursor-pointer hover:bg-surface-2')}
            >
              <Checkbox checked={added || picked.has(p.alias)} disabled={added} onCheckedChange={(v) => toggle(p.alias, v)} />
              <OsIcon family={p.family} className="size-6 text-[10px]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{p.name}</span>
                <span className="block truncate font-mono text-[11px] text-fg-3">{p.alias}</span>
              </span>
              <span className="shrink-0 text-[11px] text-fg-3">{added ? t('images.presetAdded1') : p.forVm ? 'LXC · KVM' : 'LXC'}</span>
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

export default function AdminImages() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminImageDTO | 'new' | null>(null);
  const [presets, setPresets] = useState(false);
  const [arch, setArch] = useState<ImageArch>('x86_64');
  const q = useQuery({ queryKey: ['admin-images'], queryFn: () => api.get<AdminImageDTO[]>('/admin/images') });
  const rows = q.data?.filter((i) => i.arch === arch);
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/images/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-images'] }),
    onError: (e) => toast.fromError(e),
  });
  return (
    <>
      <PageHeader
        title={t('nav.admin.images')}
        description={t('images.subtitle')}
        actions={
          <>
            <Button icon={<ListPlus />} onClick={() => setPresets(true)} disabled={!q.data}>
              {t('images.presetButton')}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
              {t('images.add')}
            </Button>
          </>
        }
      />
      <TabBar<ImageArch>
        value={arch}
        onChange={setArch}
        className="mb-4"
        items={IMAGE_ARCHES.map((a) => ({ value: a, label: a, icon: <Cpu />, count: q.data?.filter((i) => i.arch === a).length ?? null }))}
      />
      <Card key={arch} className="panel-enter">
        <DataTable
          rows={rows}
          loading={q.isLoading}
          rowKey={(i) => i.id}
          empty={<Empty title={t('images.emptyArch', { arch })} icon={<Disc3 />} />}
          columns={[
            {
              key: 'name',
              header: t('common.name'),
              cell: (i) => (
                <div className="flex items-center gap-2.5">
                  <OsIcon family={i.family} className="size-7 text-[11px]" />
                  <span className="font-medium text-fg">{i.name}</span>
                  {!i.enabled && <Badge>{t('common.disabled')}</Badge>}
                </div>
              ),
            },
            { key: 'alias', header: t('images.alias'), cell: (i) => <span className="font-mono text-xs">{i.alias}</span> },
            { key: 'server', header: t('images.source'), cell: (i) => <span className="text-xs break-all text-fg-3">{i.server.replace(/^https?:\/\//, '')}</span> },
            {
              key: 'types',
              header: t('images.supports'),
              cell: (i) => (
                <div className="flex flex-wrap gap-1">
                  {i.forContainer && <Badge>LXC</Badge>}
                  {i.forVm && <Badge>KVM</Badge>}
                  {i.cloudInit && <Badge tone="primary">cloud-init</Badge>}
                </div>
              ),
            },
            {
              key: 'actions',
              header: '',
              className: 'w-24',
              cell: (i) => (
                <div className="flex justify-end gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setEditing(i)}>
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={t('common.delete')}
                    onClick={async () => {
                      if (await confirm({ title: t('images.deleteTitle', { name: i.name }), danger: true })) remove.mutate(i.id);
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {editing && <ImageDialog image={editing === 'new' ? undefined : editing} arch={arch} onClose={() => setEditing(null)} />}
      {presets && q.data && <PresetDialog existing={q.data} arch={arch} onClose={() => setPresets(false)} />}
    </>
  );
}
