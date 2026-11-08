// 宿主机「智能分流」：开关、出口列表（WireGuard / SOCKS5 / HTTP）与 Agent 执行情况。
// 保存后配置版本递增，宿主机 Agent 在下一次心跳（约 10 秒）拉取并应用；私钥与密码只下发给宿主机 Agent。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileInput, Pencil, Plus, Route, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EGRESS_TYPES, type AdminEgressDTO, type AdminNodeEgressDTO, type EgressType, type NodeDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, PasswordInput, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, Empty, ErrorState, PageLoading, Switch, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDate, fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';

interface EgressForm {
  name: string;
  type: EgressType;
  enabled: boolean;
  sortOrder: string;
  remark: string;
  wg: { privateKey: string; address: string; peerPublicKey: string; presharedKey: string; endpoint: string; mtu: string; keepalive: string };
  proxy: { host: string; port: string; username: string; password: string };
}

const toForm = (e?: AdminEgressDTO): EgressForm => ({
  name: e?.name ?? '',
  type: e?.type ?? 'WIREGUARD',
  enabled: e?.enabled ?? true,
  sortOrder: String(e?.sortOrder ?? 0),
  remark: e?.remark ?? '',
  // 私钥 / 密码不回显：留空表示不修改
  wg: {
    privateKey: '',
    address: e?.wireguard?.address ?? '',
    peerPublicKey: e?.wireguard?.peerPublicKey ?? '',
    presharedKey: '',
    endpoint: e?.wireguard?.endpoint ?? '',
    mtu: String(e?.wireguard?.mtu ?? 1420),
    keepalive: String(e?.wireguard?.keepalive ?? 25),
  },
  proxy: { host: e?.proxy?.host ?? '', port: e?.proxy ? String(e.proxy.port) : '', username: e?.proxy?.username ?? '', password: '' },
});

/** 从 wg-quick 配置文件导入（[Interface] PrivateKey / Address / MTU，[Peer] PublicKey / PresharedKey / Endpoint / PersistentKeepalive） */
function parseWgQuick(text: string): Partial<EgressForm['wg']> {
  const out: Partial<EgressForm['wg']> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    switch (key.toLowerCase()) {
      case 'privatekey':
        out.privateKey = value;
        break;
      case 'address':
        out.address = value;
        break;
      case 'mtu':
        out.mtu = value;
        break;
      case 'publickey':
        out.peerPublicKey = value;
        break;
      case 'presharedkey':
        out.presharedKey = value;
        break;
      case 'endpoint':
        out.endpoint = value;
        break;
      case 'persistentkeepalive':
        out.keepalive = value;
        break;
    }
  }
  return out;
}

function EgressDialog({ nodeId, egress, onClose }: { nodeId: number; egress: AdminEgressDTO | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState(() => toForm(egress ?? undefined));
  const [importing, setImporting] = useState(false);
  const [conf, setConf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const editing = !!egress;
  const sameType = editing && egress.type === f.type;
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        type: f.type,
        enabled: f.enabled,
        sortOrder: Number(f.sortOrder) || 0,
        remark: f.remark.trim() || null,
        ...(f.type === 'WIREGUARD'
          ? { wireguard: { ...f.wg, mtu: Number(f.wg.mtu) || 1420, keepalive: Number(f.wg.keepalive) || 0 } }
          : { proxy: { ...f.proxy, port: Number(f.proxy.port) } }),
      };
      return editing ? api.put<AdminNodeEgressDTO>(`/admin/nodes/${nodeId}/egress/${egress.id}`, body) : api.post<AdminNodeEgressDTO>(`/admin/nodes/${nodeId}/egress`, body);
    },
    onSuccess: (d) => {
      qc.setQueryData(['node-egress', nodeId], d);
      toast.success(t('egress.saved'), t('egress.savedDesc'));
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const wg = (k: keyof EgressForm['wg']) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, wg: { ...f.wg, [k]: e.target.value } });
  const px = (k: keyof EgressForm['proxy']) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, proxy: { ...f.proxy, [k]: e.target.value } });
  const keepHint = (has: boolean | undefined) => (sameType && has ? t('egress.keepSecret') : undefined);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={editing ? t('egress.edit', { name: egress.name }) : t('egress.add')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('egress.name')} required>
            <Input autoFocus value={f.name} maxLength={32} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('egress.namePlaceholder')} />
          </FormField>
          <FormField label={t('egress.type')}>
            <Select<EgressType>
              value={f.type}
              onChange={(type) => setF({ ...f, type })}
              options={EGRESS_TYPES.map((v) => ({ value: v, label: t(`egress.typeName.${v}`), description: t(`egress.typeDesc.${v}`) }))}
            />
          </FormField>
        </div>

        {f.type === 'WIREGUARD' ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-fg-3">{t('egress.wgHint')}</p>
              <Button size="sm" variant="ghost" icon={<FileInput />} onClick={() => setImporting(!importing)}>
                {t('egress.importConf')}
              </Button>
            </div>
            {importing && (
              <div className="space-y-2 rounded-lg border border-line bg-surface-2/50 p-3">
                <Textarea rows={6} className="font-mono text-xs" value={conf} onChange={(e) => setConf(e.target.value)} placeholder={'[Interface]\nPrivateKey = ...\nAddress = 10.7.0.2/32\n\n[Peer]\nPublicKey = ...\nEndpoint = 203.0.113.9:51820'} />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!conf.trim()}
                    onClick={() => {
                      setF({ ...f, wg: { ...f.wg, ...parseWgQuick(conf) } });
                      setImporting(false);
                      setConf('');
                    }}
                  >
                    {t('egress.importApply')}
                  </Button>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('egress.wgPrivateKey')} required={!sameType || !egress?.wireguard?.hasPrivateKey} description={keepHint(egress?.wireguard?.hasPrivateKey)}>
                <PasswordInput className="font-mono" value={f.wg.privateKey} onChange={wg('privateKey')} autoComplete="off" placeholder={sameType && egress?.wireguard?.hasPrivateKey ? t('egress.secretSet') : ''} />
              </FormField>
              <FormField label={t('egress.wgAddress')} required description={t('egress.wgAddressHint')}>
                <Input className="font-mono" value={f.wg.address} onChange={wg('address')} placeholder="10.7.0.2/32" />
              </FormField>
              <FormField label={t('egress.wgPeerPublicKey')} required>
                <Input className="font-mono" value={f.wg.peerPublicKey} onChange={wg('peerPublicKey')} />
              </FormField>
              <FormField label={t('egress.wgEndpoint')} required>
                <Input className="font-mono" value={f.wg.endpoint} onChange={wg('endpoint')} placeholder="203.0.113.9:51820" />
              </FormField>
              <FormField label={`${t('egress.wgPresharedKey')}${t('common.optionalSuffix')}`} description={keepHint(egress?.wireguard?.hasPresharedKey)}>
                <PasswordInput className="font-mono" value={f.wg.presharedKey} onChange={wg('presharedKey')} autoComplete="off" placeholder={sameType && egress?.wireguard?.hasPresharedKey ? t('egress.secretSet') : ''} />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="MTU">
                  <Input type="number" min={1280} max={1500} value={f.wg.mtu} onChange={wg('mtu')} />
                </FormField>
                <FormField label={t('egress.wgKeepalive')}>
                  <Input type="number" min={0} max={300} value={f.wg.keepalive} onChange={wg('keepalive')} />
                </FormField>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-fg-3">{t('egress.proxyHint')}</p>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <FormField label={t('egress.proxyHost')} required>
                <Input className="font-mono" value={f.proxy.host} onChange={px('host')} placeholder="198.51.100.4" />
              </FormField>
              <FormField label={t('egress.proxyPort')} required>
                <Input type="number" min={1} max={65535} value={f.proxy.port} onChange={px('port')} placeholder={f.type === 'HTTP' ? '8080' : '1080'} />
              </FormField>
              <FormField label={`${t('common.username')}${t('common.optionalSuffix')}`}>
                <Input value={f.proxy.username} onChange={px('username')} autoComplete="off" />
              </FormField>
              <FormField label={`${t('common.password')}${t('common.optionalSuffix')}`} description={keepHint(egress?.proxy?.hasPassword)}>
                <PasswordInput value={f.proxy.password} onChange={px('password')} autoComplete="off" placeholder={sameType && egress?.proxy?.hasPassword ? t('egress.secretSet') : ''} />
              </FormField>
            </div>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <FormField label={`${t('common.remark')}${t('common.optionalSuffix')}`} description={t('egress.remarkHint')}>
            <Input value={f.remark} maxLength={100} onChange={(e) => setF({ ...f, remark: e.target.value })} placeholder={t('egress.remarkPlaceholder')} />
          </FormField>
          <FormField label={t('common.sortOrder')}>
            <Input type="number" min={0} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />
          </FormField>
        </div>
        <Switch checked={f.enabled} onCheckedChange={(enabled) => setF({ ...f, enabled })} label={t('egress.enabled')} description={t('egress.enabledDesc')} />
      </div>
    </Modal>
  );
}

/** 一个出口：类型、名称、地址、状态与使用的实例数 */
function EgressRow({ e, onEdit, onDelete }: { e: AdminEgressDTO; onEdit: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const st = e.status;
  const target = e.wireguard ? e.wireguard.endpoint : e.proxy ? `${e.proxy.host}:${e.proxy.port}` : '';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-medium text-fg">{e.name}</span>
          <Tag tone={e.type === 'WIREGUARD' ? 'primary' : 'neutral'}>{t(`egress.typeName.${e.type}`)}</Tag>
          {!e.enabled && <Tag>{t('egress.disabled')}</Tag>}
          {e.enabled && (
            <Badge tone={!st ? 'neutral' : st.ok ? 'success' : 'danger'} dot>
              {!st ? t('egress.statusPending') : st.ok ? t('egress.statusOk') : t('egress.statusDown')}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-3">
          <span className="font-mono">{target}</span>
          {e.wireguard && <span className="font-mono">{e.wireguard.address}</span>}
          {e.remark && <span>{e.remark}</span>}
        </div>
        {st && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-3">
            {st.handshakeAt && <span>{t('egress.handshake', { time: fromNow(st.handshakeAt) })}</span>}
            {(st.rx > 0 || st.tx > 0) && <span className="tabular">↓ {formatBytes(st.rx)} · ↑ {formatBytes(st.tx)}</span>}
            {st.latency !== null && <span className="tabular">{t('egress.latency', { ms: st.latency })}</span>}
            {st.error && <span className="text-danger-text">{st.error}</span>}
          </div>
        )}
      </div>
      <span className="tabular shrink-0 text-xs text-fg-3">{t('egress.instanceCount', { n: e.instanceCount })}</span>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} title={t('common.edit')} onClick={onEdit}>
          <Pencil />
        </Button>
        <Button size="icon-sm" variant="danger-ghost" aria-label={t('common.delete')} title={t('common.delete')} onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

export function NodeEgressTab({ node }: { node: NodeDTO }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['node-egress', node.id];
  // 等待 Agent 应用期间每 5 秒刷新一次状态
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<AdminNodeEgressDTO>(`/admin/nodes/${node.id}/egress`),
    refetchInterval: (query) => (query.state.data && query.state.data.appliedVersion !== query.state.data.version ? 5000 : 30_000),
  });
  const [editing, setEditing] = useState<AdminEgressDTO | null | 'new'>(null);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put<AdminNodeEgressDTO>(`/admin/nodes/${node.id}/egress/enabled`, { enabled }),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      void qc.invalidateQueries({ queryKey: ['node', node.id] });
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete<AdminNodeEgressDTO>(`/admin/nodes/${node.id}/egress/${id}`),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      toast.success(t('egress.deleted'));
    },
    onError: (e) => toast.fromError(e),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoading />;
  const d = q.data;
  const pending = d.enabled && d.appliedVersion !== d.version;
  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Route className="size-4 text-fg-3" />
              <h3 className="text-[15px] font-semibold text-fg">{t('egress.title')}</h3>
            </div>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-3">{t('egress.desc')}</p>
          </div>
          <Switch checked={d.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} label={t('egress.toggle')} />
        </div>
        {/* Agent 状态与配置应用情况 */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs text-fg-3">
          <span className="flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', d.agent.online ? 'bg-success' : 'bg-fg-4')} />
            {d.agent.online ? (d.agent.supported ? t('egress.agentReady') : t('egress.agentOld')) : t('egress.agentOffline')}
          </span>
          <span>
            {pending
              ? t('egress.pending')
              : d.appliedAt
                ? t('egress.applied', { version: d.appliedVersion ?? 0, time: formatDate(d.appliedAt) })
                : t('egress.neverApplied')}
          </span>
        </div>
        {d.applyError && (
          <Alert tone="danger" className="mt-3">
            {d.applyError}
          </Alert>
        )}
        {d.enabled && d.agent.online && !d.agent.supported && (
          <Alert tone="warning" className="mt-3">
            {t('egress.agentOldDesc')}
          </Alert>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <span className="text-[13px] font-medium text-fg">{t('egress.list', { n: d.items.length })}</span>
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
            {t('egress.add')}
          </Button>
        </div>
        {d.items.length === 0 ? (
          <Empty icon={<Route />} title={t('egress.empty')} description={t('egress.emptyDesc')} />
        ) : (
          <div className="divide-y divide-line/70">
            {d.items.map((e) => (
              <EgressRow
                key={e.id}
                e={e}
                onEdit={() => setEditing(e)}
                onDelete={async () => {
                  if (await confirm({ title: t('egress.deleteTitle', { name: e.name }), description: t('egress.deleteDesc', { n: e.instanceCount }), danger: true })) remove.mutate(e.id);
                }}
              />
            ))}
          </div>
        )}
      </Card>
      <p className="text-xs leading-relaxed text-fg-3">{t('egress.footnote')}</p>
      {editing && <EgressDialog nodeId={node.id} egress={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
