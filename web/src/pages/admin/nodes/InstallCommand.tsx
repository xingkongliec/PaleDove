import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, PlugZap, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { InstallCommandDTO, NodeDTO, AdminSettingsDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Alert, CodeBlock, Skeleton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

/** 安装脚本回连面板使用的地址未设置时提示 */
function PanelUrlHint() {
  const { t } = useI18n();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<AdminSettingsDTO>('/admin/settings'), staleTime: 60_000 });
  if (!settings.data || settings.data.panelUrl) return null;
  return <Alert tone="warning">{t('install.panelUrlHint')}</Alert>;
}

/** 安装命令与执行说明（Caddy 安装脚本） */
export function InstallCommandPanel({ install }: { install: InstallCommandDTO }) {
  const { t } = useI18n();
  if (!install.scriptUrl) return <Alert tone="success">{install.command.replace(/^#\s*/, '')}</Alert>;
  return (
    <div className="space-y-3">
      <ol className="space-y-1.5 text-sm text-fg-2">
        <li className="flex gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-fg">1</span>
          {t('install.step1Caddy')}
        </li>
        <li className="flex gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-fg">2</span>
          {t('install.step2')}
        </li>
      </ol>
      <CodeBlock value={install.command} />
      <p className="text-xs text-fg-3">{t('install.expires', { time: formatDate(install.expiresAt) })}</p>
      <PanelUrlHint />
    </div>
  );
}

function InstallOptionsSummary({ install }: { install: InstallCommandDTO }) {
  const { t } = useI18n();
  const options = install.installOptions;
  if (!options) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
      <span className="font-medium text-fg-2">{t('nodeForm.installOptions')}</span>
      <span>{t('nodeForm.installAgent')}: {options.agent ? t('common.enabled') : t('common.disabled')}</span>
      <span>{t('nodeForm.installFirewall')}: {options.firewall ? t('common.enabled') : t('common.disabled')}</span>
      <span>{t('nodeForm.enableFirewallRules')}: {options.firewallRules ? t('common.enabled') : t('common.disabled')}</span>
    </div>
  );
}

function Step({ n, done, title, description, last, children }: { n: number; done: boolean; title: string; description: ReactNode; last?: boolean; children: ReactNode }) {
  return (
    <li className="relative flex gap-3.5">
      {/* 步骤之间的连线 */}
      {!last && <span className={cn('absolute top-7 bottom-0 left-[11px] w-px', done ? 'bg-fg/40' : 'bg-line')} aria-hidden />}
      <span
        className={cn(
          'relative flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
          done ? 'bg-success text-white' : 'bg-primary text-primary-fg',
        )}
      >
        {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
      </span>
      <div className={cn('min-w-0 flex-1 space-y-3', !last && 'pb-7')}>
        <div className="pt-0.5">
          <h4 className="text-sm font-semibold text-fg">{title}</h4>
          <p className="mt-1 text-[13px] text-fg-3">{description}</p>
        </div>
        {children}
      </div>
    </li>
  );
}

/**
 * 宿主机安装的两个步骤：执行安装脚本 → 验证并连接。
 * 安装脚本成功回调面板时宿主机会自动接入，验证步骤随之完成。
 */
export function NodeInstallSteps({
  node,
  install,
  onGenerate,
  regenerating,
  error,
}: {
  node: NodeDTO;
  install: InstallCommandDTO | null;
  /** regenerate 为 true 时签发新令牌（之前的命令失效），否则沿用有效期内的命令 */
  onGenerate: (regenerate: boolean) => void;
  regenerating: boolean;
  error?: unknown;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post<{ node: NodeDTO; result: { version: string; warnings: string[] } }>(`/admin/nodes/${node.id}/verify`),
    onSuccess: (r) => {
      qc.setQueryData(['admin-node', node.id], r.node);
      void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
    },
  });
  const connected = node.status !== 'PENDING';
  const warnings = verify.data?.result.warnings ?? [];
  return (
    <ol>
      <Step n={1} done={connected} title={t('nodes.runScript')} description={t('nodes.runScriptDesc')}>
        {regenerating ? <Skeleton className="h-16 w-full" /> : install ? (
          <>
            <CodeBlock value={install.command} />
            <InstallOptionsSummary install={install} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-3">
              <span>{t('install.expires', { time: formatDate(install.expiresAt) })}</span>
              <button type="button" className="inline-flex items-center gap-1 font-medium text-fg-2 hover:text-fg disabled:opacity-50" disabled={regenerating} onClick={() => onGenerate(true)}>
                <RefreshCw className={cn('size-3', regenerating && 'animate-spin')} />
                {t('nodeDetail.regenerate')}
              </button>
            </div>
            <PanelUrlHint />
          </>
        ) : (
          <Button size="sm" loading={regenerating} onClick={() => onGenerate(false)}>
            {t('nodeDetail.generate')}
          </Button>
        )}
        {error != null && <Alert tone="danger">{errorText(error)}</Alert>}
      </Step>
      <Step n={2} done={connected} last title={t('nodes.verifyStep')} description={t('nodes.verifyStepDesc')}>
        {connected ? (
          <Alert tone={node.status === 'ONLINE' ? 'success' : 'warning'} title={node.status === 'ONLINE' ? t('nodes.registered') : t('nodes.registeredOffline')}>
            {node.status === 'ONLINE' ? [node.incusVersion && `Incus ${node.incusVersion}`, ...warnings].filter(Boolean).join('；') || undefined : node.lastError}
          </Alert>
        ) : (
          <>
            <Button icon={<PlugZap />} loading={verify.isPending} onClick={() => verify.mutate()}>
              {t('nodes.verify')}
            </Button>
            {verify.error && (
              <Alert tone="danger" title={t('nodes.verifyFailed')}>
                {errorText(verify.error)}
              </Alert>
            )}
          </>
        )}
      </Step>
    </ol>
  );
}
