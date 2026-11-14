import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { avatarUrl, DEFAULT_AVATAR_API, EMAIL_DOMAIN_MODES, normalizeEmailDomain, type AdminSettingsDTO, type EmailDomainMode, type SiteSettings, type TransferFeeMode } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input, InputGroup, Textarea } from '@/components/ui/input';
import { Card, CardBody, ErrorState, FormRow, PageLoading, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { OAuthSettings } from './OAuthSettings';
import { PanelCertificateCard } from './PanelCertificate';
import { MailSettingsCard } from './MailSettings';
import { LogoMark } from '@/layouts/AppShell';
import { MaintenanceSettingsCard } from './MaintenanceSettings';
import { PopupSettingsCard } from './PopupSettings';

type Tab = 'site' | 'mail' | 'maintenance' | 'lifecycle' | 'market' | 'sites' | 'oauth' | 'cert' | 'general' | 'popups';
const TABS: Tab[] = ['site', 'mail', 'maintenance', 'lifecycle', 'market', 'sites', 'oauth', 'cert', 'popups', 'general'];

/** 系统设置：按类别分标签，每个标签单独保存；标签写在地址栏（?tab=），可直接链接 */
export default function AdminSettings() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<AdminSettingsDTO>('/admin/settings'), enabled: !['payment', 'legal', 'aff'].includes(raw ?? '') });
  if (raw === 'payment') return <Navigate to="/admin/billing?tab=payment" replace />;
  if (raw === 'legal') return <Navigate to="/admin/documents" replace />;
  if (raw === 'aff') return <Navigate to="/admin/affiliate" replace />;
  const tab = TABS.find((value) => value === raw) ?? 'site';
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading />;
  const data = q.data;
  const content: Record<Tab, ReactNode> = {
    site: <SiteSettingsCard value={data} />,
    mail: <MailSettingsCard />,
    maintenance: <MaintenanceSettingsCard />,
    popups: <PopupSettingsCard />,
    general: <GeneralSettingsCard value={data} />,
    lifecycle: <LifecycleSettings value={data} />,
    market: <MarketSettings value={data} />,
    sites: <SiteBindingSettings value={data} />,
    oauth: <OAuthSettings />,
    cert: <PanelCertificateCard />,
  };
  return (
    <div>
      <PageHeader title={t('nav.admin.settings')} />
      <TabBar<Tab>
        value={tab}
        onChange={(v) => setParams(v === 'site' ? {} : { tab: v }, { replace: true })}
        className="mb-4"
        items={[
          { value: 'site', label: t('adminSettings.tab.site') },
          { value: 'mail', label: t('adminSettings.tab.mail') },
          { value: 'maintenance', label: t('maintenance.title') },
          { value: 'lifecycle', label: t('adminSettings.lifecycle') },
          { value: 'market', label: t('adminSettings.tab.market') },
          { value: 'sites', label: t('adminSettings.tab.sites') },
          { value: 'oauth', label: t('oauthAdmin.title') },
          { value: 'cert', label: t('adminSettings.tab.cert') },
          { value: 'popups', label: t('popup.tab') },
          { value: 'general', label: t('adminSettings.tab.general') },
        ]}
      />
      <div key={tab} className="panel-enter">
        {content[tab]}
      </div>
    </div>
  );
}

/** 表单状态：仅在服务端返回的 value 变化时重置 */
function useForm<T extends object>(value: T) {
  const [form, setForm] = useState<T>(value);
  useEffect(() => setForm(value), [value]);
  const set = <K extends keyof T>(k: K, v: T[K]) => setForm((f) => ({ ...f, [k]: v }));
  return { form, set };
}

/** 保存一部分设置（接口按字段合并），成功后刷新设置与公开配置 */
function useSaveSettings() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<SiteSettings>) => api.put<AdminSettingsDTO>('/admin/settings', patch),
    onSuccess: (d) => {
      qc.setQueryData(['admin-settings'], d);
      void qc.invalidateQueries({ queryKey: ['public-config'] });
      toast.success(t('adminSettings.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
}

function SaveBar({ onSave, loading }: { onSave: () => void; loading: boolean }) {
  const t = useT();
  return (
    <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
      <Button variant="primary" loading={loading} onClick={onSave}>
        {t('common.save')}
      </Button>
    </div>
  );
}

/** 解析后缀列表：一行一个，也接受逗号、空格、分号分隔；规范化并去重 */
const parseDomains = (text: string) => [...new Set(text.split(/[\s,，;；]+/).map(normalizeEmailDomain).filter(Boolean))];

function SiteSettingsCard({ value }: { value: AdminSettingsDTO }) {
  const t = useT();
  const siteValue = useMemo(
    () => ({
      siteName: value.siteName,
      allowRegister: value.allowRegister,
      requireEmailVerification: value.requireEmailVerification,
      allowTickets: value.allowTickets,
      signupBonus: value.signupBonus,
      emailDomainMode: value.emailDomainMode,
      emailDomains: value.emailDomains.join('\n'),
    }),
    [value.siteName, value.allowRegister, value.requireEmailVerification, value.allowTickets, value.signupBonus, value.emailDomainMode, value.emailDomains],
  );
  const { form, set } = useForm(siteValue);
  const save = useSaveSettings();
  return (
    <Card>
      <CardBody>
        <SiteIconRow value={value} />
        <FormRow label={t('adminSettings.siteName')}>
          <Input className="max-w-sm" value={form.siteName} onChange={(e) => set('siteName', e.target.value)} />
        </FormRow>
        <FormRow label={t('adminSettings.registerRow')}>
          <Switch checked={form.allowRegister} onCheckedChange={(v) => set('allowRegister', v)} label={t('adminSettings.allowRegister')} />
        </FormRow>
        {/* 注册邮箱后缀：不限制 / 白名单 / 黑名单；后缀匹配子域名，已有账号不受影响 */}
        <FormRow label={t('adminSettings.emailDomains')} hint={t(`adminSettings.emailDomainHint.${form.emailDomainMode}`)}>
          <div className="w-full max-w-sm space-y-2">
            <Select<EmailDomainMode>
              value={form.emailDomainMode}
              onChange={(v) => set('emailDomainMode', v)}
              aria-label={t('adminSettings.emailDomains')}
              options={EMAIL_DOMAIN_MODES.map((m) => ({ value: m, label: t(`adminSettings.emailDomainMode.${m}`), description: t(`adminSettings.emailDomainModeDesc.${m}`) }))}
            />
            {form.emailDomainMode !== 'OFF' && (
              <>
                <Textarea
                  className="font-mono text-xs"
                  rows={4}
                  value={form.emailDomains}
                  onChange={(e) => set('emailDomains', e.target.value)}
                  placeholder={form.emailDomainMode === 'ALLOW' ? 'qq.com\ngmail.com\nedu.cn' : 'mailinator.com\ntempmail.com\n10minutemail.com'}
                />
                <p className="text-xs text-fg-3">{t('adminSettings.emailDomainCount', { n: parseDomains(form.emailDomains).length })}</p>
              </>
            )}
          </div>
        </FormRow>
        <FormRow label={t('adminSettings.emailVerification')} hint={value.mailEnabled ? t('adminSettings.emailVerificationHint') : t('adminSettings.emailVerificationNoMail')}>
          <Switch checked={form.requireEmailVerification} onCheckedChange={(v) => set('requireEmailVerification', v)} label={t('adminSettings.requireEmailVerification')} />
        </FormRow>
        <FormRow label={t('adminSettings.tickets')} hint={t('adminSettings.ticketsHint')}>
          <Switch checked={form.allowTickets} onCheckedChange={(v) => set('allowTickets', v)} label={t('adminSettings.allowTickets')} />
        </FormRow>
        <FormRow label={t('adminSettings.signupBonus')}>
          <div className="w-40"><InputGroup type="number" min={0} max={10000} step={0.01} value={String(form.signupBonus)} onChange={(e) => set('signupBonus', Number(e.target.value))} suffix={t('adminSettings.yuan')} /></div>
        </FormRow>
        <SaveBar
          loading={save.isPending}
          onSave={() =>
            save.mutate({
              siteName: form.siteName,
              allowRegister: form.allowRegister,
              requireEmailVerification: form.requireEmailVerification,
              allowTickets: form.allowTickets,
              signupBonus: form.signupBonus,
              emailDomainMode: form.emailDomainMode,
              // 一行一个，也接受逗号、空格、分号分隔；服务端统一规范化并去重
              emailDomains: parseDomains(form.emailDomains),
            })
          }
        />
      </CardBody>
    </Card>
  );
}

function SiteIconRow({ value }: { value: AdminSettingsDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const [url, setUrl] = useState(value.iconSource);
  useEffect(() => setUrl(value.iconSource), [value.iconSource]);
  const update = useMutation({
    mutationFn: (reset: boolean) => reset ? api.delete<AdminSettingsDTO>('/admin/settings/icon') : api.put<AdminSettingsDTO>('/admin/settings/icon', { url: url.trim() }),
    onSuccess: (data) => { qc.setQueryData(['admin-settings'], data); void qc.invalidateQueries({ queryKey: ['public-config'] }); toast.success(t('adminSettings.saved')); },
    onError: (error) => toast.fromError(error),
  });
  return <FormRow label={t('adminSettings.siteIcon')} hint={t('adminSettings.siteIconHint')}>
    <div className="flex max-w-xl flex-wrap items-center gap-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line"><LogoMark className="size-6" /></span>
      <Input className="min-w-32 flex-1 font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/logo.png" aria-label={t('adminSettings.siteIcon')} />
      <Button variant="primary" disabled={!url.trim() || update.isPending} loading={update.isPending && !update.variables} onClick={() => update.mutate(false)}>{t('adminSettings.apply')}</Button>
      {value.icon && <Button disabled={update.isPending} onClick={() => update.mutate(true)}>{t('adminSettings.resetIcon')}</Button>}
    </div>
  </FormRow>;
}

function GeneralSettingsCard({ value }: { value: AdminSettingsDTO }) {
  const t = useT(); const { form, set } = useForm(value); const save = useSaveSettings();
  return <Card><CardBody>
    <FormRow label={t('adminSettings.panelUrl')} hint={t('adminSettings.panelUrlHint')}><Input className="max-w-xl font-mono text-xs" value={value.panelUrl} readOnly disabled placeholder={t('adminSettings.panelUrlUnset')} /></FormRow>
    <FormRow label={t('adminSettings.footer')} hint={t('adminSettings.footerHint')}><Input className="max-w-xl" value={form.footer} onChange={(e) => set('footer', e.target.value)} /></FormRow>
    {/* 头像 API：右侧按当前填写的地址预览几种风格 */}
    <FormRow label={t('adminSettings.avatarApi')} hint={t('adminSettings.avatarApiHint')}>
      <div className="flex max-w-xl flex-wrap items-center gap-3">
        <Input className="min-w-0 flex-1 font-mono text-xs" value={form.avatarApiBase} onChange={(e) => set('avatarApiBase', e.target.value)} placeholder={DEFAULT_AVATAR_API} />
        <span className="flex items-center gap-1">
          {(['bigSmile', 'pixelArt', 'bottts', 'notionists'] as const).map((style) => {
            const src = avatarUrl(form.avatarApiBase, { style, seed: 'paledove', variant: 0 }, 56);
            return src ? <img key={style} src={src} alt="" className="size-7" /> : null;
          })}
        </span>
      </div>
    </FormRow>
    <SaveBar loading={save.isPending} onSave={() => save.mutate({ footer: form.footer, avatarApiBase: form.avatarApiBase.trim() })} />
  </CardBody></Card>;
}

function LifecycleSettings({ value }: { value: AdminSettingsDTO }) {
  const t = useT();
  const { form, set } = useForm(value);
  const save = useSaveSettings();
  return (
    <Card>
      <CardBody>
        <FormRow label={t('adminSettings.graceDays')} hint={t('adminSettings.graceDaysHint')}>
          <InputGroup type="number" min={0} value={String(form.graceDays)} onChange={(e) => set('graceDays', Number(e.target.value))} suffix={t('adminSettings.unitDays')} className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.autoRenewHours')} hint={t('adminSettings.autoRenewHoursHint')}>
          <InputGroup type="number" min={1} value={String(form.autoRenewHours)} onChange={(e) => set('autoRenewHours', Number(e.target.value))} suffix={t('adminSettings.unitHours')} className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.cooldown')} hint={t('adminSettings.cooldownHint')}>
          <InputGroup
            type="number"
            min={0}
            value={String(form.reinstallCooldownMinutes)}
            onChange={(e) => set('reinstallCooldownMinutes', Number(e.target.value))}
            suffix={t('adminSettings.unitMinutes')}
            className="w-32"
          />
        </FormRow>
        <FormRow label={t('adminSettings.nodeSwitchFee')} hint={t('adminSettings.nodeSwitchFeeHint')}>
          <InputGroup type="number" min={0} step={0.01} value={String(form.nodeSwitchFee)} onChange={(e) => set('nodeSwitchFee', Number(e.target.value))} prefix={form.currency} className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.vpcLimit')} hint={t('adminSettings.vpcLimitHint')}>
          <InputGroup type="number" min={0} max={100} value={String(form.vpcLimit)} onChange={(e) => set('vpcLimit', Number(e.target.value))} suffix={t('adminSettings.unitCount')} className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.transferFee')} hint={t('adminSettings.transferFeeHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <Select<TransferFeeMode>
              className="w-56"
              value={form.transferFeeMode}
              onChange={(v) => set('transferFeeMode', v)}
              options={(['NONE', 'FIXED', 'PERCENT'] as const).map((v) => ({ value: v, label: t(`adminSettings.transferFee.${v}`), description: t(`adminSettings.transferFeeDesc.${v}`) }))}
            />
            {form.transferFeeMode !== 'NONE' && (
              <InputGroup
                type="number"
                min={0}
                step={form.transferFeeMode === 'PERCENT' ? 1 : 0.01}
                value={String(form.transferFeeValue)}
                onChange={(e) => set('transferFeeValue', Number(e.target.value))}
                prefix={form.transferFeeMode === 'FIXED' ? form.currency : undefined}
                suffix={form.transferFeeMode === 'PERCENT' ? '%' : undefined}
                className="w-32"
                aria-label={t('adminSettings.transferFee')}
              />
            )}
          </div>
        </FormRow>
        <SaveBar
          loading={save.isPending}
          onSave={() =>
            save.mutate({
              graceDays: form.graceDays,
              autoRenewHours: form.autoRenewHours,
              reinstallCooldownMinutes: form.reinstallCooldownMinutes,
              vpcLimit: form.vpcLimit,
              transferFeeMode: form.transferFeeMode,
              transferFeeValue: form.transferFeeValue,
              nodeSwitchFee: form.nodeSwitchFee,
            })
          }
        />
      </CardBody>
    </Card>
  );
}

/** 交易市场：开关、成交手续费与挂牌门槛 */
function MarketSettings({ value }: { value: AdminSettingsDTO }) {
  const t = useT();
  const { form, set } = useForm(value);
  const save = useSaveSettings();
  return (
    <Card>
      <CardBody>
        <FormRow label={t('adminSettings.marketEnabled')} hint={t('adminSettings.marketEnabledHint')}>
          <Switch checked={form.marketEnabled} onCheckedChange={(v) => set('marketEnabled', v)} label={t('adminSettings.marketEnabledLabel')} />
        </FormRow>
        <FormRow label={t('adminSettings.marketFeeRate')} hint={t('adminSettings.marketFeeRateHint')}>
          <InputGroup type="number" min={0} max={50} step={0.1} value={String(form.marketFeeRate)} onChange={(e) => set('marketFeeRate', Number(e.target.value))} suffix="%" className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.marketMinDays')} hint={t('adminSettings.marketMinDaysHint')}>
          <InputGroup type="number" min={0} max={365} value={String(form.marketMinDays)} onChange={(e) => set('marketMinDays', Number(e.target.value))} suffix={t('batch.daysUnit')} className="w-32" />
        </FormRow>
        <SaveBar loading={save.isPending} onSave={() => save.mutate({ marketEnabled: form.marketEnabled, marketFeeRate: form.marketFeeRate, marketMinDays: form.marketMinDays })} />
      </CardBody>
    </Card>
  );
}

function SiteBindingSettings({ value }: { value: AdminSettingsDTO }) {
  const t = useT();
  const { form, set } = useForm(value);
  const save = useSaveSettings();
  return (
    <Card>
      <CardBody>
        <FormRow label={t('adminSettings.dnsRow')} hint={t('adminSettings.dnsCheckHint')}>
          <Switch checked={form.requireDnsCheck} onCheckedChange={(v) => set('requireDnsCheck', v)} label={t('adminSettings.dnsCheck')} />
        </FormRow>
        <FormRow label={t('adminSettings.acmeEmail')} hint={t('adminSettings.acmeEmailHint')}>
          <Input type="email" className="max-w-sm" value={form.acmeEmail} onChange={(e) => set('acmeEmail', e.target.value)} />
        </FormRow>
        <SaveBar loading={save.isPending} onSave={() => save.mutate({ requireDnsCheck: form.requireDnsCheck, acmeEmail: form.acmeEmail })} />
      </CardBody>
    </Card>
  );
}
