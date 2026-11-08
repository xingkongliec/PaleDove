// 宿主机的可用系统镜像：默认使用面板的全部镜像，也可以只提供勾选的镜像。
// 购买时只会分配到提供所选镜像的宿主机，重装时只能选择宿主机提供的镜像。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminImageDTO, NodeDTO } from '../../../shared/index';
import { OsIcon } from '@/components/status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/input';
import { Alert, Card, CardBody, CardHeader, Checkbox, ErrorState, Skeleton, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

type Mode = 'default' | 'custom';

export function NodeImagesTab({ node }: { node: NodeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const images = useQuery({ queryKey: ['admin-images'], queryFn: () => api.get<AdminImageDTO[]>('/admin/images') });
  const initial = { mode: (node.imageIds ? 'custom' : 'default') as Mode, ids: node.imageIds ?? [] };
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [ids, setIds] = useState<number[]>(initial.ids);
  // 只列出与宿主机架构一致的镜像；架构尚未读取时列出全部
  const list = (images.data ?? []).filter((i) => !node.arch || i.arch === node.arch);
  const picked = new Set(ids);
  const dirty = mode !== initial.mode || (mode === 'custom' && [...ids].sort().join() !== [...initial.ids].sort().join());

  const save = useMutation({
    mutationFn: () => api.patch<NodeDTO>(`/admin/nodes/${node.id}`, { imageIds: mode === 'custom' ? ids : null }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['admin-node', node.id] });
      void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const reset = () => {
    setMode(initial.mode);
    setIds(initial.ids);
  };

  if (images.error) return <ErrorState error={images.error} onRetry={() => images.refetch()} />;
  return (
    <Card>
      <CardHeader title={t('nodeForm.images')} description={t('nodeImages.desc')} />
      <CardBody className="space-y-4">
        <p className="-mt-1 text-xs text-fg-3">{node.arch ? t('nodeImages.archFiltered', { arch: node.arch }) : t('nodeImages.archUnknown')}</p>
        <FormField label={t('nodeForm.imageMode')} className="max-w-md">
          <Select
            value={mode}
            onChange={(v) => {
              setMode(v);
              // 第一次切换到自定义时预选全部已启用的镜像，再去掉不需要的
              if (v === 'custom' && !ids.length) setIds(list.filter((i) => i.enabled).map((i) => i.id));
            }}
            options={[
              { value: 'default', label: t('nodeForm.imageDefault'), description: t('nodeForm.imageDefaultDesc') },
              { value: 'custom', label: t('nodeForm.imageCustom'), description: t('nodeForm.imageCustomDesc') },
            ]}
          />
        </FormField>

        {mode === 'custom' && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-3">
              <span>{t('nodeForm.imagePicked', { n: list.filter((i) => picked.has(i.id)).length, total: list.length })}</span>
              <button type="button" className="text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => setIds(list.map((i) => i.id))}>
                {t('nodeForm.selectAll')}
              </button>
              <button type="button" className="text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => setIds([])}>
                {t('nodeForm.selectNone')}
              </button>
            </div>
            {images.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((i) => (
                  <label
                    key={i.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-1.5',
                      picked.has(i.id) ? 'border-line-strong bg-surface-2' : 'border-line hover:bg-surface-2',
                      !i.enabled && 'opacity-60',
                    )}
                  >
                    <Checkbox checked={picked.has(i.id)} onCheckedChange={(v) => setIds(v ? [...ids, i.id] : ids.filter((x) => x !== i.id))} />
                    <OsIcon family={i.family} className="size-6 text-[10px]" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{i.name}</span>
                    <span className="flex shrink-0 gap-1">
                      {i.arch === 'aarch64' && <Tag>aarch64</Tag>}
                      {i.forContainer && <Tag>LXC</Tag>}
                      {i.forVm && <Tag>KVM</Tag>}
                      {!i.enabled && <Tag tone="warning">{t('common.disabled')}</Tag>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {!picked.size && (
              <Alert tone="warning" className="mt-3">
                {t('nodeForm.imageNoneWarn')}
              </Alert>
            )}
          </div>
        )}
      </CardBody>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        {dirty && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-fg-3">
            <span className="size-1.5 rounded-full bg-warning" />
            {t('common.unsaved')}
          </span>
        )}
        <Button disabled={!dirty} onClick={reset}>
          {t('nodeDetail.discard')}
        </Button>
        <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
          {t('common.saveChanges')}
        </Button>
      </div>
    </Card>
  );
}
