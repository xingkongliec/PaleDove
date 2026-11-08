import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { hasIpv6Mode, isPublicIpv4Mode, NETWORK_MODES, type NetworkMode, type NodeDTO, type PublicNicMode, type TrafficMode } from '../../../shared/index';
import { CountrySelect } from '@/components/country';
import { Button } from '@/components/ui/button';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n, useT, type MessageKey } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { trafficModeOptions } from '@/lib/plans';

export interface NodeFormValues {
  name: string;
  description: string;
  address: string;
  apiPort: string;
  country: string;
  networkMode: NetworkMode;
  publicIp: string;
  publicIpv6: string;
  natListenAddress: string;
  natListenAddressV6: string;
  ipv6Subnet: string;
  ipv6Parent: string;
  portRangeStart: string;
  portRangeEnd: string;
  publicNicMode: PublicNicMode;
  publicNicParent: string;
  dnsServers: string;
  installAgent: boolean;
  installFirewall: boolean;
  enableFirewallRules: boolean;
  // 以下仅在编辑页面修改
  region: string;
  serverFingerprint: string;
  project: string;
  storagePool: string;
  profile: string;
  natNetwork: string;
  maxInstances: string;
  requireRealName: boolean;
  pingEnabled: boolean;
  announcement: string;
  trafficLimit: string;
  trafficResetDay: string;
  trafficMode: TrafficMode;
  enabled: boolean;
  sortOrder: string;
  caddyAdminPort: string;
}

/** 名称只能包含英文字母、数字、- 和 _ */
export const NODE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function nodeToForm(n?: NodeDTO): NodeFormValues {
  return {
    name: n?.name ?? '',
    description: n?.description ?? '',
    address: n?.address ?? '',
    apiPort: String(n?.apiPort ?? 8443),
    country: n?.country ?? '',
    networkMode: n?.networkMode ?? 'NAT',
    publicIp: n?.publicIp ?? '',
    publicIpv6: n?.publicIpv6 ?? '',
    // 旧数据中的 0.0.0.0 与留空等价
    natListenAddress: n?.natListenAddress === '0.0.0.0' ? '' : (n?.natListenAddress ?? ''),
    natListenAddressV6: n?.natListenAddressV6 ?? '',
    ipv6Subnet: n?.ipv6Subnet ?? '',
    ipv6Parent: n?.ipv6Parent ?? '',
    portRangeStart: String(n?.portRangeStart ?? 20000),
    portRangeEnd: String(n?.portRangeEnd ?? 60000),
    publicNicMode: n?.publicNicMode ?? 'ROUTED',
    publicNicParent: n?.publicNicParent ?? '',
    dnsServers: n?.dnsServers ?? '1.1.1.1,8.8.8.8',
    installAgent: n?.installAgent ?? true,
    installFirewall: n?.installFirewall ?? false,
    enableFirewallRules: n?.enableFirewallRules ?? false,
    region: n?.region ?? '',
    serverFingerprint: n?.serverFingerprint ?? '',
    project: n?.project ?? 'default',
    storagePool: n?.storagePool ?? 'default',
    profile: n?.profile ?? 'default',
    natNetwork: n?.natNetwork ?? 'incusbr0',
    maxInstances: String(n?.maxInstances ?? 100),
    requireRealName: n?.requireRealName ?? false,
    pingEnabled: n?.pingEnabled ?? false,
    announcement: n?.announcement ?? '',
    trafficLimit: String(n?.trafficLimit ?? 0),
    trafficResetDay: String(n?.trafficResetDay ?? 1),
    trafficMode: n?.trafficMode ?? 'BOTH',
    enabled: n?.enabled ?? true,
    sortOrder: String(n?.sortOrder ?? 0),
    caddyAdminPort: String(n?.caddyAdminPort ?? 2021),
  };
}

/** 添加宿主机时提交的字段，其余使用服务端默认值 */
export function hostPayload(v: NodeFormValues) {
  return {
    name: v.name,
    description: v.description,
    address: v.address,
    apiPort: Number(v.apiPort),
    country: v.country,
    networkMode: v.networkMode,
    publicIp: v.publicIp,
    publicIpv6: v.publicIpv6,
    natListenAddress: v.natListenAddress,
    natListenAddressV6: v.natListenAddressV6,
    ipv6Subnet: v.ipv6Subnet,
    ipv6Parent: v.ipv6Parent,
    portRangeStart: Number(v.portRangeStart),
    portRangeEnd: Number(v.portRangeEnd),
    publicNicMode: v.publicNicMode,
    publicNicParent: v.publicNicParent || null,
    dnsServers: v.dnsServers,
    installAgent: v.installAgent,
    installFirewall: v.installFirewall,
    enableFirewallRules: v.installFirewall && v.enableFirewallRules,
  };
}

/** 节点安装脚本选项；防火墙规则默认关闭，避免改动宿主机现有网络策略。 */
export function InstallOptionsFields({ value, onChange }: { value: NodeFormValues; onChange: Setter }) {
  const t = useT();
  return (
    <Section title={t('nodeForm.installOptions')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Switch checked={value.installAgent} onCheckedChange={(v) => onChange({ ...value, installAgent: v })} label={t('nodeForm.installAgent')} description={t('nodeForm.installAgentDesc')} />
        <Switch checked={value.installFirewall} onCheckedChange={(v) => onChange({ ...value, installFirewall: v, enableFirewallRules: v ? value.enableFirewallRules : false })} label={t('nodeForm.installFirewall')} description={t('nodeForm.installFirewallDesc')} />
        <Switch
          checked={value.enableFirewallRules}
          disabled={!value.installFirewall}
          onCheckedChange={(v) => onChange({ ...value, enableFirewallRules: v })}
          label={t('nodeForm.enableFirewallRules')}
          description={t('nodeForm.enableFirewallRulesDesc')}
        />
      </div>
      {value.installFirewall && value.enableFirewallRules && <p className="text-xs text-warning-text">{t('nodeForm.firewallWarning')}</p>}
    </Section>
  );
}

export function formToPayload(v: NodeFormValues) {
  return {
    ...hostPayload(v),
    region: v.region,
    serverFingerprint: v.serverFingerprint || null,
    project: v.project,
    storagePool: v.storagePool,
    profile: v.profile,
    natNetwork: v.natNetwork,
    maxInstances: Number(v.maxInstances),
    requireRealName: v.requireRealName,
    pingEnabled: v.pingEnabled,
    announcement: v.announcement.trim(),
    trafficLimit: Number(v.trafficLimit) || 0,
    trafficResetDay: Number(v.trafficResetDay) || 1,
    trafficMode: v.trafficMode,
    enabled: v.enabled,
    sortOrder: Number(v.sortOrder),
    caddyAdminPort: Number(v.caddyAdminPort),
  };
}

type Setter = (v: NodeFormValues) => void;

export const MODE_LABEL: Record<NetworkMode, MessageKey> = {
  NAT: 'nodeForm.mode.NAT',
  NAT_IPV6: 'nodeForm.mode.NAT_IPV6',
  IPV6_ONLY: 'nodeForm.mode.IPV6_ONLY',
  IPV4: 'nodeForm.mode.IPV4',
  IPV4_IPV6: 'nodeForm.mode.IPV4_IPV6',
};

const MODE_DESC: Record<NetworkMode, MessageKey> = {
  NAT: 'nodeForm.modeDesc.NAT',
  NAT_IPV6: 'nodeForm.modeDesc.NAT_IPV6',
  IPV6_ONLY: 'nodeForm.modeDesc.IPV6_ONLY',
  IPV4: 'nodeForm.modeDesc.IPV4',
  IPV4_IPV6: 'nodeForm.modeDesc.IPV4_IPV6',
};

function useField(value: NodeFormValues, onChange: Setter) {
  return (k: keyof NodeFormValues) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
}

/** 表单分区：放在同一张卡片里，分区之间以细线分隔 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line px-4 py-4 first:border-t-0 sm:px-5">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

/** 宽屏四列，平板两列，手机一列 */
const GRID = 'grid gap-x-3 gap-y-3.5 sm:grid-cols-2 xl:grid-cols-4';

/** 卡片底部的操作区 */
export function FormFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-4 py-3 sm:px-5">{children}</div>;
}

/** 分段选择：网络模式 */
function ModeSwitch({ value, onChange }: { value: NetworkMode; onChange: (m: NetworkMode) => void }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t('nodeForm.networkMode')} className="grid w-full grid-cols-2 gap-0.5 rounded-lg bg-surface-3 p-0.5 sm:inline-grid sm:w-auto sm:grid-cols-5">
      {NETWORK_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cn(
            'truncate rounded-md px-3 py-1.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === m ? 'bg-surface font-medium text-fg shadow-xs' : 'text-fg-3 hover:text-fg',
          )}
        >
          {t(MODE_LABEL[m])}
        </button>
      ))}
    </div>
  );
}

/** 名称、国家或地区、连接地址与描述 */
export function HostFields({ value, onChange }: { value: NodeFormValues; onChange: Setter }) {
  const t = useT();
  const set = useField(value, onChange);
  const badName = value.name !== '' && !NODE_NAME.test(value.name);
  return (
    <Section title={t('nodeForm.basic')}>
      <div className={GRID}>
        <FormField label={t('nodeForm.name')} required error={badName ? t('nodeForm.nameHint') : undefined}>
          <Input value={value.name} onChange={set('name')} placeholder="node-01" autoComplete="off" />
        </FormField>
        <FormField label={t('nodeForm.country')} required>
          <CountrySelect value={value.country} onChange={(country) => onChange({ ...value, country })} />
        </FormField>
        <div className="grid grid-cols-[1fr_6rem] gap-x-3 sm:col-span-2">
          <FormField label={t('nodeForm.address')} required>
            <Input value={value.address} onChange={set('address')} className="font-mono text-xs" placeholder={t('nodeForm.addressPlaceholder')} />
          </FormField>
          <FormField label={t('nodeForm.apiPort')}>
            <Input type="number" value={value.apiPort} onChange={set('apiPort')} />
          </FormField>
        </div>
        <FormField label={t('nodeForm.description')} className="sm:col-span-2">
          <Input value={value.description} onChange={set('description')} placeholder="Hong Kong DC1" />
        </FormField>
      </div>
    </Section>
  );
}

/** 网络模式与对应配置：NAT 模式配置端口映射；独立 IPv4 模式配置网卡；带 IPv6 的模式配置子网 */
export function NetworkFields({ value, onChange }: { value: NodeFormValues; onChange: Setter }) {
  const t = useT();
  const set = useField(value, onChange);
  const mode = value.networkMode;
  return (
    <>
      <Section title={t('nodeForm.networkTitle')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ModeSwitch value={mode} onChange={(networkMode) => onChange({ ...value, networkMode })} />
          <p className="text-xs text-fg-3">{t(MODE_DESC[mode])}</p>
        </div>
      </Section>

      {/* NAT 端口映射：IPv6 Only 与独立 IPv4 模式没有 */}
      {mode !== 'IPV6_ONLY' && !isPublicIpv4Mode(mode) && (
        <Section title={t('nodeForm.nat')}>
          <div className={GRID}>
            <FormField label={t('nodeForm.publicIp')}>
              <Input value={value.publicIp} onChange={set('publicIp')} className="font-mono text-xs" placeholder={t('nodeForm.publicIpPlaceholder')} />
            </FormField>
            <FormField label={t('nodeForm.publicIpv6')}>
              <Input value={value.publicIpv6} onChange={set('publicIpv6')} className="font-mono text-xs" placeholder={t('nodeForm.optional')} />
            </FormField>
            <FormField label={t('nodeForm.listenIpv4')}>
              <Input value={value.natListenAddress} onChange={set('natListenAddress')} className="font-mono text-xs" placeholder={t('nodeForm.listenPublicIp')} />
            </FormField>
            <FormField label={t('nodeForm.listenIpv6')}>
              <Input value={value.natListenAddressV6} onChange={set('natListenAddressV6')} className="font-mono text-xs" placeholder={t('nodeForm.listenAll')} />
            </FormField>
            <FormField label={t('nodeForm.portRange')}>
              <div className="flex items-center gap-2">
                <Input type="number" value={value.portRangeStart} onChange={set('portRangeStart')} aria-label={t('nodeForm.portStart')} />
                <span className="text-fg-4">–</span>
                <Input type="number" value={value.portRangeEnd} onChange={set('portRangeEnd')} aria-label={t('nodeForm.portEnd')} />
              </div>
            </FormField>
          </div>
        </Section>
      )}

      {isPublicIpv4Mode(mode) && (
        <Section title={t('nodeForm.ipv4')}>
          <div className={GRID}>
            <FormField label={t('nodeForm.nicMode')}>
              <Select
                value={value.publicNicMode}
                onChange={(v) => onChange({ ...value, publicNicMode: v })}
                options={[
                  { value: 'ROUTED', label: t('nodeForm.nicRouted') },
                  { value: 'BRIDGED', label: t('nodeForm.nicBridged') },
                ]}
              />
            </FormField>
            <FormField label={value.publicNicMode === 'ROUTED' ? t('nodeForm.parentRouted') : t('nodeForm.parentBridged')}>
              <Input
                value={value.publicNicParent}
                onChange={set('publicNicParent')}
                className="font-mono text-xs"
                placeholder={value.publicNicMode === 'ROUTED' ? 'eth0' : 'br0'}
              />
            </FormField>
            <FormField label={t('nodeForm.dns')}>
              <Input value={value.dnsServers} onChange={set('dnsServers')} className="font-mono text-xs" />
            </FormField>
          </div>
        </Section>
      )}

      {hasIpv6Mode(mode) && (
        <Section title={t('nodeForm.ipv6')}>
          <div className={GRID}>
            <FormField label={t('nodeForm.ipv6Subnet')}>
              <Input value={value.ipv6Subnet} onChange={set('ipv6Subnet')} className="font-mono text-xs" placeholder="2001:db8::/48" />
            </FormField>
            <FormField label={t('nodeForm.ipv6Parent')}>
              <Input value={value.ipv6Parent} onChange={set('ipv6Parent')} className="font-mono text-xs" placeholder="eth0" />
            </FormField>
          </div>
          <p className="text-xs text-warning-text">{t('nodeForm.ipv6Later')}</p>
        </Section>
      )}
    </>
  );
}

/** 宿主机流量周期：额度、每月重置日与计算方式（概览中统计本机所有实例的流量） */
function TrafficSection({ value, onChange }: { value: NodeFormValues; onChange: Setter }) {
  const { t, L } = useI18n();
  const set = useField(value, onChange);
  return (
    <Section title={t('nodeForm.traffic')}>
      <div className={GRID}>
        <FormField label={t('nodeForm.trafficLimit')}>
          <InputGroup type="number" min={0} suffix="GB" value={value.trafficLimit} onChange={set('trafficLimit')} placeholder={t('nodeForm.unlimited')} />
        </FormField>
        <FormField label={t('nodeForm.trafficResetDay')}>
          <InputGroup type="number" min={1} max={28} suffix={t('nodeForm.dayUnit')} value={value.trafficResetDay} onChange={set('trafficResetDay')} />
        </FormField>
        <FormField label={t('nodeForm.trafficMode')}>
          <Select value={value.trafficMode} onChange={(v) => onChange({ ...value, trafficMode: v })} options={trafficModeOptions(t, L)} />
        </FormField>
      </div>
    </Section>
  );
}

/** 编辑页面的其余设置：销售、流量与 Incus 连接 */
export function AdvancedFields({ value, onChange, endpoint }: { value: NodeFormValues; onChange: Setter; endpoint: string }) {
  const t = useT();
  const set = useField(value, onChange);
  const [fpError, setFpError] = useState<string | null>(null);
  const fetchFp = useMutation({
    mutationFn: () => api.post<{ fingerprint: string }>('/admin/nodes/fingerprint', { endpoint }),
    onSuccess: (r) => {
      setFpError(null);
      onChange({ ...value, serverFingerprint: r.fingerprint });
    },
    onError: (e) => setFpError(errorText(e)),
  });
  return (
    <>
      <Section title={t('nodeForm.sales')}>
        <div className={GRID}>
          <FormField label={t('common.region')}>
            <Input value={value.region} onChange={set('region')} placeholder={t('nodeForm.regionPlaceholder')} />
          </FormField>
          <FormField label={t('nodeForm.maxInstances')}>
            <Input type="number" value={value.maxInstances} onChange={set('maxInstances')} />
          </FormField>
          <div className="flex items-end pb-1.5 sm:col-span-2">
            <Switch checked={value.enabled} onCheckedChange={(v) => onChange({ ...value, enabled: v })} label={t('nodeForm.enabled')} description={t('nodeForm.enabledDesc')} />
          </div>
          <div className="sm:col-span-2">
            <Switch checked={value.requireRealName} onCheckedChange={(v) => onChange({ ...value, requireRealName: v })} label={t('nodeForm.requireRealName')} description={t('nodeForm.requireRealNameDesc')} />
          </div>
          {/* 节点测试：由宿主机 Agent 每小时向国内三网目标 Ping，结果展示在购买页 */}
          <div className="sm:col-span-2">
            <Switch checked={value.pingEnabled} onCheckedChange={(v) => onChange({ ...value, pingEnabled: v })} label={t('nodeForm.pingEnabled')} description={t('nodeForm.pingEnabledDesc')} />
          </div>
          {/* 宿主机公告：显示在这台宿主机上全部实例的实例管理页面 */}
          <FormField label={t('nodeForm.announcement')} description={t('nodeForm.announcementDesc')} className="sm:col-span-full">
            <Textarea rows={3} maxLength={2000} value={value.announcement} onChange={(e) => onChange({ ...value, announcement: e.target.value })} placeholder={t('nodeForm.announcementPlaceholder')} />
          </FormField>
        </div>
      </Section>
      <TrafficSection value={value} onChange={onChange} />
      <Section title={t('nodeForm.incus')}>
        <div className={GRID}>
          <FormField label={t('nodeForm.fingerprint')} error={fpError} className="sm:col-span-2">
            <div className="flex gap-1.5">
              <Input value={value.serverFingerprint} onChange={set('serverFingerprint')} className="font-mono text-xs" placeholder={t('nodeForm.fingerprintPlaceholder')} />
              <Button loading={fetchFp.isPending} disabled={!endpoint.startsWith('https://')} onClick={() => fetchFp.mutate()}>
                {t('nodeForm.fetch')}
              </Button>
            </div>
          </FormField>
          <FormField label={t('nodeForm.poolName')}>
            <Input value={value.storagePool} onChange={set('storagePool')} />
          </FormField>
          <FormField label={t('nodeForm.bridge')}>
            <Input value={value.natNetwork} onChange={set('natNetwork')} />
          </FormField>
          <FormField label={t('nodeForm.caddyPort')}>
            <Input type="number" value={value.caddyAdminPort} onChange={set('caddyAdminPort')} />
          </FormField>
          <FormField label="Project">
            <Input value={value.project} onChange={set('project')} />
          </FormField>
          <FormField label="Profile">
            <Input value={value.profile} onChange={set('profile')} />
          </FormField>
          <FormField label={t('common.sortOrder')}>
            <Input type="number" value={value.sortOrder} onChange={set('sortOrder')} />
          </FormField>
        </div>
      </Section>
    </>
  );
}
