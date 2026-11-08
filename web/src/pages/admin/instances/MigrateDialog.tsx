import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { isNatType, isPublicIpv4Mode, type InstanceType, type NodeDTO } from '../../../shared/index';
import { CountryFlag } from '@/components/country';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { MODE_LABEL } from '../nodes/NodeForm';

/**
 * 选择迁移的目标宿主机。传入 type 时（单个实例）只列出网络模式匹配的宿主机；
 * 批量迁移时列出全部已安装的宿主机，不匹配的实例由服务端逐个拒绝并给出原因。
 */
export function MigrateDialog({
  open,
  onOpenChange,
  title,
  currentNodeId,
  type,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  currentNodeId?: number;
  type?: InstanceType;
  pending: boolean;
  error?: string | null;
  onSubmit: (targetNodeId: number) => void;
}) {
  const t = useT();
  const [target, setTarget] = useState<number | null>(null);
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes'), enabled: open });
  useEffect(() => {
    if (open) setTarget(null);
  }, [open]);

  const options = (nodes.data ?? [])
    .filter((n) => n.status !== 'PENDING' && n.id !== currentNodeId)
    .filter((n) => !type || isPublicIpv4Mode(n.networkMode) !== isNatType(type))
    .map((n) => ({
      value: n.id,
      label: (
        <span className="inline-flex items-center gap-2">
          {n.country && <CountryFlag code={n.country} />}
          {n.name}
        </span>
      ),
      description: `${n.region} · ${t(MODE_LABEL[n.networkMode])} · ${t('migrate.instanceCount', { n: n.instanceCount, max: n.maxInstances })}${n.status === 'OFFLINE' ? ` · ${t('migrate.offline')}` : ''}`,
      disabled: n.status === 'OFFLINE' || !n.enabled,
    }));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={t('migrate.desc')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={pending} disabled={!target} onClick={() => target && onSubmit(target)}>
            {t('migrate.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('migrate.target')}>
          <Select value={target} onChange={setTarget} options={options} placeholder={nodes.isLoading ? t('common.loading') : t('migrate.targetPlaceholder')} />
        </FormField>
        {options.length === 0 && !nodes.isLoading && <p className="text-sm text-fg-3">{t('migrate.noTarget')}</p>}
        <Alert tone="neutral">
          <ul className="list-disc space-y-1 pl-4 text-[13px]">
            <li>{t('migrate.note1')}</li>
            <li>{t('migrate.note2')}</li>
            <li>{t('migrate.note3')}</li>
          </ul>
        </Alert>
      </div>
    </Modal>
  );
}
