// SSH 公钥：账号设置里管理（粘贴已有公钥 / 在浏览器本地生成密钥对），购买和重装实例时直接选用
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeySquare, Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { SshKeyDTO } from '../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert, Card, CardHeader, CopyButton, Empty, Tag } from '@/components/ui/misc';
import { MultiSelect, Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { generateSshKey, sshKeygenSupported, type SshKeyAlgo } from '@/lib/ssh-keygen';
import { toast } from '@/lib/toast';

/** 账号保存的公钥（管理员没有） */
export function useSshKeys() {
  const { data: me } = useMe();
  return useQuery({ queryKey: ['ssh-keys'], queryFn: () => api.get<SshKeyDTO[]>('/ssh-keys'), enabled: !!me && me.role !== 'ADMIN', staleTime: 60_000 });
}

/** 密钥类型的简短名称：ED25519 / RSA 4096 / ECDSA … */
export function keyTypeLabel(k: Pick<SshKeyDTO, 'type' | 'bits'>): string {
  const base = k.type.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, 'ecdsa-').replace(/@openssh\.com$/, '').toUpperCase();
  return k.bits ? `${base} ${k.bits}` : base;
}

function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 粘贴已有公钥：名称留空时用公钥末尾的注释 */
function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const add = useMutation({
    mutationFn: () => api.post<SshKeyDTO>('/ssh-keys', { name: name.trim() || undefined, publicKey: key.trim() }),
    onSuccess: (k) => {
      toast.success(t('sshKeys.added', { name: k.name }));
      void qc.invalidateQueries({ queryKey: ['ssh-keys'] });
      setName('');
      setKey('');
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('sshKeys.addTitle')}
      description={t('sshKeys.addDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!key.trim()} loading={add.isPending} onClick={() => add.mutate()}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('sshKeys.publicKey')} required description={t('sshKeys.publicKeyHint')}>
          <Textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-xs break-all" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… user@host" autoFocus />
        </FormField>
        <FormField label={`${t('sshKeys.name')}${t('common.optionalSuffix')}`} description={t('sshKeys.nameHint')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder={t('sshKeys.namePlaceholder')} />
        </FormField>
        {add.error && <Alert tone="danger">{errorText(add.error)}</Alert>}
      </div>
    </Modal>
  );
}

/** 生成密钥对：在浏览器本地生成，公钥自动保存到账号，私钥只在这里显示和下载一次 */
function GenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [name, setName] = useState('');
  const [algo, setAlgo] = useState<SshKeyAlgo>('ed25519');
  const [result, setResult] = useState<{ privateKey: string; publicKey: string; file: string; saved: SshKeyDTO | null; saveError: string | null } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const gen = useMutation({
    mutationFn: async () => {
      const label = name.trim() || `${me?.username ?? 'paledove'}-${new Date().toISOString().slice(0, 10)}`;
      const pair = await generateSshKey(algo, label.replace(/\s+/g, '-'));
      let saved: SshKeyDTO | null = null;
      let saveError: string | null = null;
      try {
        saved = await api.post<SshKeyDTO>('/ssh-keys', { name: label, publicKey: pair.publicKey });
      } catch (e) {
        saveError = errorText(e);
      }
      return { ...pair, file: algo === 'ed25519' ? 'id_ed25519' : 'id_rsa', saved, saveError };
    },
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['ssh-keys'] });
    },
    onError: (e) => toast.error(algo === 'ed25519' ? t('sshKeys.ed25519Unsupported') : errorText(e)),
  });
  const close = () => {
    setResult(null);
    setDownloaded(false);
    setName('');
    onClose();
  };

  if (result) {
    return (
      <Modal
        open={open}
        onOpenChange={(o) => !o && close()}
        size="lg"
        title={t('sshKeys.generatedTitle')}
        description={result.saved ? t('sshKeys.generatedSaved', { name: result.saved.name }) : undefined}
        footer={
          <>
            <Button icon={<Download />} onClick={() => downloadText(`${result.file}.pub`, `${result.publicKey}\n`)}>
              {t('sshKeys.downloadPublic')}
            </Button>
            <Button
              variant="primary"
              icon={<Download />}
              onClick={() => {
                downloadText(result.file, result.privateKey);
                setDownloaded(true);
              }}
            >
              {t('sshKeys.downloadPrivate')}
            </Button>
            <Button onClick={close}>{downloaded ? t('common.done') : t('common.close')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning" icon={<TriangleAlert />}>
            {t('sshKeys.privateOnce')}
          </Alert>
          {result.saveError && <Alert tone="danger">{t('sshKeys.saveFailed', { error: result.saveError })}</Alert>}
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-fg-3">
              <span>
                {t('sshKeys.privateKey')} <span className="font-mono">({result.file})</span>
              </span>
              <CopyButton value={result.privateKey} label={t('sshKeys.copyPrivate')} />
            </div>
            <Textarea readOnly rows={7} value={result.privateKey} className="font-mono text-[11px] leading-snug" onFocus={(e) => e.currentTarget.select()} />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-fg-3">
              <span>{t('sshKeys.publicKey')}</span>
              <CopyButton value={result.publicKey} />
            </div>
            <p className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] break-all text-fg-2">{result.publicKey}</p>
          </div>
          <p className="text-xs leading-relaxed text-fg-3">{t('sshKeys.usage', { file: result.file })}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && close()}
      title={t('sshKeys.generateTitle')}
      description={t('sshKeys.generateDesc')}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<Sparkles />} loading={gen.isPending} disabled={!sshKeygenSupported()} onClick={() => gen.mutate()}>
            {t('sshKeys.generate')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('sshKeys.algo')}>
          <Select<SshKeyAlgo>
            value={algo}
            onChange={setAlgo}
            options={[
              { value: 'ed25519', label: 'Ed25519', description: t('sshKeys.algoDesc.ed25519') },
              { value: 'rsa', label: 'RSA 4096', description: t('sshKeys.algoDesc.rsa') },
            ]}
          />
        </FormField>
        <FormField label={`${t('sshKeys.name')}${t('common.optionalSuffix')}`} description={t('sshKeys.genNameHint')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder={t('sshKeys.namePlaceholder')} />
        </FormField>
        {!sshKeygenSupported() && <Alert tone="danger">{t('sshKeys.insecure')}</Alert>}
      </div>
    </Modal>
  );
}

/** 账号设置 · SSH 公钥 */
export function SshKeysCard() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useSshKeys();
  const [adding, setAdding] = useState(false);
  const [generating, setGenerating] = useState(false);
  const remove = async (k: SshKeyDTO) => {
    if (!(await confirm({ title: t('sshKeys.deleteTitle', { name: k.name }), description: t('sshKeys.deleteDesc'), danger: true, confirmText: t('common.delete') }))) return;
    try {
      await api.delete(`/ssh-keys/${k.id}`);
      toast.success(t('sshKeys.deleted'));
      void qc.invalidateQueries({ queryKey: ['ssh-keys'] });
    } catch (e) {
      toast.fromError(e);
    }
  };
  const keys = q.data ?? [];
  return (
    <Card>
      <CardHeader
        title={t('sshKeys.title')}
        actions={
          <div className="flex gap-2">
            <Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => setGenerating(true)}>
              {t('sshKeys.generatePair')}
            </Button>
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
              {t('sshKeys.add')}
            </Button>
          </div>
        }
      />
      <p className="border-b border-line px-5 py-3 text-xs leading-relaxed text-fg-3">{t('sshKeys.desc')}</p>
      {q.isLoading ? (
        <div className="px-5 py-8 text-center text-[13px] text-fg-3">{t('common.loading')}</div>
      ) : keys.length === 0 ? (
        <Empty icon={<KeySquare />} title={t('sshKeys.empty')} description={t('sshKeys.emptyDesc')} />
      ) : (
        <ul className="divide-y divide-line/70">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-5 py-2.5">
              <KeySquare className="size-4 shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">{k.name}</span>
                  <Tag>{keyTypeLabel(k)}</Tag>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-fg-3">
                  <span className="truncate font-mono" title={k.fingerprint}>
                    {k.fingerprint}
                  </span>
                  <span className="shrink-0 text-fg-4">· {formatDate(k.createdAt, 'YYYY-MM-DD')}</span>
                </div>
              </div>
              <CopyButton value={k.publicKey} label={t('sshKeys.copyPublic')} />
              <button type="button" onClick={() => remove(k)} title={t('common.delete')} aria-label={t('common.delete')} className="rounded p-1 text-fg-4 transition-colors hover:bg-danger-soft hover:text-danger-text">
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddDialog open={adding} onClose={() => setAdding(false)} />
      <GenerateDialog open={generating} onClose={() => setGenerating(false)} />
    </Card>
  );
}

/**
 * 购买 / 重装时选择 SSH 公钥：多选已保存的公钥，也可以临时粘贴其他公钥。
 * 返回合并后的公钥文本（一行一个），交给原有的 sshKeys 参数
 */
export function SshKeyField({ selected, onSelected, extra, onExtra, className }: { selected: number[]; onSelected: (ids: number[]) => void; extra: string; onExtra: (v: string) => void; className?: string }) {
  const t = useT();
  const keys = useSshKeys().data ?? [];
  const { data: me } = useMe();
  const [paste, setPaste] = useState(!!extra);
  return (
    <FormField
      label={`${t('store.sshKeys')}${t('common.optionalSuffix')}`}
      description={
        <>
          {t('store.sshKeysHint')}
          {me?.role !== 'ADMIN' && (
            <>
              {' '}
              <Link to="/console/account?tab=ssh" className="text-fg underline underline-offset-2">
                {t('sshKeys.manage')}
              </Link>
            </>
          )}
        </>
      }
      className={className}
    >
      <div className="space-y-2">
        {keys.length > 0 && (
          <MultiSelect<number>
            value={selected}
            onChange={onSelected}
            placeholder={t('sshKeys.pick')}
            options={keys.map((k) => ({ value: k.id, label: k.name, description: `${keyTypeLabel(k)} · ${k.fingerprint}` }))}
          />
        )}
        {paste || keys.length === 0 ? (
          <Textarea value={extra} onChange={(e) => onExtra(e.target.value)} rows={2} className="font-mono text-xs" placeholder="ssh-ed25519 AAAA..." />
        ) : (
          <button type="button" className="text-xs text-fg-3 transition-colors hover:text-fg" onClick={() => setPaste(true)}>
            + {t('sshKeys.pasteOther')}
          </button>
        )}
      </div>
    </FormField>
  );
}

/** 选中的公钥与临时粘贴的公钥合并成一行一个 */
export function combineSshKeys(keys: SshKeyDTO[] | undefined, selected: number[], extra: string): string {
  return [...(keys ?? []).filter((k) => selected.includes(k.id)).map((k) => k.publicKey), extra.trim()].filter(Boolean).join('\n');
}
