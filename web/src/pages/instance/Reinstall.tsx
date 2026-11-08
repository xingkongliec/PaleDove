import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, CircleCheck, Disc3, Plus, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ImageDTO } from '../../shared/index';
import { ImagePicker } from '@/components/ImagePicker';
import { OsIcon } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Card, CardBody, CardHeader, CodeBlock, Empty, PageLoading } from '@/components/ui/misc';
import { useInstanceApiPath, isBusy, useInvalidateInstance, type AnyInstance } from '@/hooks/instances';
import { combineSshKeys, SshKeyField, useSshKeys } from '@/components/SshKeys';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';

/** 确认面板中的系统行：标志 + 名称 */
function OsRow({ label, image, strong }: { label: ReactNode; image: { name: string; family: string } | null | undefined; strong?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {image ? <OsIcon family={image.family} className="size-8 text-xs" /> : <span className="size-8 shrink-0 rounded-md border border-dashed border-line" />}
      <div className="min-w-0">
        <div className="text-[11px] leading-4 text-fg-3">{label}</div>
        <div className={strong ? 'truncate text-sm font-semibold text-fg' : 'truncate text-[13px] text-fg-2'}>{image?.name ?? '—'}</div>
      </div>
    </div>
  );
}

export default function Reinstall({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const t = useT();
  const confirm = useConfirm();
  const invalidate = useInvalidateInstance(inst.id);
  // 实例所在宿主机提供的、支持该实例类型的镜像
  const images = useQuery({ queryKey: ['instance-images', inst.id], queryFn: () => api.get<ImageDTO[]>(`${instancePath}/images`) });
  const usable = images.data ?? [];
  const [imageId, setImageId] = useState<number | null>(inst.image?.id ?? null);
  const [password, setPassword] = useState('');
  const [sshKeys, setSshKeys] = useState('');
  const [keyIds, setKeyIds] = useState<number[]>([]);
  const savedKeys = useSshKeys().data;
  const [showKeysRaw, setShowKeys] = useState(false);
  const showKeys = showKeysRaw || !!savedKeys?.length;
  const [result, setResult] = useState<string | null>(null);

  const reinstall = useMutation({
    mutationFn: () => api.post<{ password: string }>(`${instancePath}/reinstall`, { imageId, password, sshKeys: combineSshKeys(savedKeys, keyIds, sshKeys) }),
    onSuccess: (r) => {
      setResult(r.password);
      setPassword('');
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });

  // Hook 必须在提前返回之前调用，否则加载完成后 Hook 数量变化会导致页面崩溃（白屏）
  const { data: me } = useMe();

  if (images.isLoading) return <PageLoading />;
  // 挂牌出售期间，卖家不能重装（管理员除外）
  const blocked = isBusy(inst) || ['SUSPENDED', 'CREATING', 'DELETED', 'DELETING'].includes(inst.status) || (me?.role !== 'ADMIN' && !!inst.marketListing);
  const target = usable.find((i) => i.id === imageId);
  const snapshots = inst.counts.snapshots;

  return (
    // 上下两张卡片：上面选择系统，下面一行排开重装设置（系统变化、密码与公钥、影响说明与按钮），不留大块空白
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('reinstall.choose')} description={t('reinstall.desc')} />
        <CardBody>
          {usable.length === 0 ? (
            <Empty title={t('store.noImages')} icon={<Disc3 />} />
          ) : (
            <ImagePicker aria-label={t('reinstall.choose')} images={usable} value={imageId} onChange={setImageId} current={inst.image?.id} currentLabel={t('reinstall.current')} />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('detail.tab.reinstall')} />
        <CardBody className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-2 self-start rounded-lg border border-line bg-surface-2 p-3">
            <OsRow label={t('reinstall.currentSystem')} image={inst.image} />
            <ArrowDown className="ml-2.5 size-3.5 text-fg-4" aria-hidden />
            <OsRow label={t('reinstall.target')} image={target} strong />
          </div>

          <div className="space-y-4">
            <FormField label={t('reinstall.newPassword')} description={t('common.leaveEmptyToGenerate')}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('common.autoGenerate')} autoComplete="new-password" />
            </FormField>
            {showKeys ? (
              <SshKeyField selected={keyIds} onSelected={setKeyIds} extra={sshKeys} onExtra={setSshKeys} />
            ) : (
              <Button size="sm" variant="ghost" icon={<Plus />} className="-ml-2" onClick={() => setShowKeys(true)}>
                {t('store.addSshKey')}
              </Button>
            )}
          </div>

          <div className="flex flex-col gap-4">
            {/* 影响说明：丢失的内容用警示色，保留的内容用中性色 */}
            <ul className="space-y-1.5 text-xs leading-relaxed">
              <li className="flex gap-2 text-danger-text">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t('reinstall.lossDisk')}
              </li>
              {snapshots > 0 && (
                <li className="flex gap-2 text-danger-text">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {t('reinstall.lossSnapshots', { n: snapshots })}
                </li>
              )}
              <li className="flex gap-2 text-fg-3">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t('reinstall.keep')}
              </li>
            </ul>

            <Button
              variant="danger"
              icon={<Disc3 />}
              className="mt-auto w-full"
              disabled={!imageId || blocked}
              loading={reinstall.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: t('reinstall.confirmTitle', { name: inst.hostname, image: target?.name ?? '' }),
                  description: t('reinstall.confirmDesc'),
                  danger: true,
                  confirmText: t('reinstall.confirm'),
                  requireText: inst.hostname,
                });
                if (ok) reinstall.mutate();
              }}
            >
              {t('detail.tab.reinstall')}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Modal
        open={!!result}
        onOpenChange={(o) => !o && setResult(null)}
        title={t('reinstall.submitted')}
        description={t('reinstall.submittedDesc')}
        footer={
          <Button variant="primary" onClick={() => setResult(null)}>
            {t('reinstall.saved')}
          </Button>
        }
      >
        {result && <CodeBlock value={result} />}
      </Modal>
    </div>
  );
}
