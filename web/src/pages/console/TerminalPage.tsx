// 终端连接：新建连接时选择实例，每个连接是一个标签页，可同时保持多个会话
import { Keyboard, Layers, Maximize2, Minimize2, Plus, RefreshCw, Server, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { InstanceDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { PageHeader } from '@/components/page';
import { OsIcon } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/input';
import { Card, Empty } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { isBusy, useInstances } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatCores, formatMemory } from '@/lib/format';
import { TerminalSettings, useTerminalBackground, WebTerminal, type TerminalHandle, type TerminalStatus } from '@/pages/instance/Terminal';
import { connectAddress } from './Instances';

interface Session {
  key: number;
  inst: InstanceDTO;
  /** 重新连接时递增，重建终端 */
  nonce: number;
}

const canConnect = (i: InstanceDTO) => i.status === 'RUNNING' && !isBusy(i);

/** 新建连接：下拉选择实例，下方预览所选实例（系统、地址、配置、地区）和终端使用提示 */
function NewSessionDialog({ open, onClose, onConnect }: { open: boolean; onClose: () => void; onConnect: (inst: InstanceDTO) => void }) {
  const { t, L } = useI18n();
  const q = useInstances();
  const list = (q.data ?? []).filter((i) => i.status !== 'DELETED');
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    if (open) setPicked(list.find(canConnect)?.id ?? null);
    // 只在打开时选择默认实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const inst = list.find((i) => i.id === picked);
  const runningCount = list.filter(canConnect).length;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('terminalPage.new')}
      description={t('terminalPage.newDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<SquareTerminal />} disabled={!inst || !canConnect(inst)} onClick={() => inst && onConnect(inst)}>
            {t('terminalPage.connect')}
          </Button>
        </>
      }
    >
      {list.length === 0 ? (
        <Empty icon={<Server />} title={t('instances.empty')} />
      ) : (
        <div className="space-y-4">
          <FormField label={t('nav.instances')} description={t('terminalPage.runningCount', { n: runningCount, total: list.length })}>
            <Select<number>
              value={picked ?? 0}
              onChange={setPicked}
              placeholder={t('terminalPage.pick')}
              options={list.map((i) => ({
                value: i.id,
                label: i.hostname,
                description: [i.image?.name, connectAddress(i), L.instanceStatus[i.status]].filter(Boolean).join(' · '),
                disabled: !canConnect(i),
              }))}
            />
          </FormField>
          {inst && (
            // 所选实例的预览：标题栏（系统图标、登录用户、状态）+ 基本信息
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="flex items-center gap-2.5 border-b border-line bg-surface-2/60 px-3.5 py-2.5">
                {inst.image ? <OsIcon family={inst.image.family} className="size-8 bg-surface text-[10px]" /> : <SquareTerminal className="size-5 text-fg-3" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] font-medium text-fg">root@{inst.hostname}</div>
                  <div className="truncate text-[11px] text-fg-3">{inst.image?.name ?? '—'}</div>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-2">
                  <span className={cn('size-2 rounded-full', canConnect(inst) ? 'bg-success' : 'bg-fg-4')} />
                  {L.instanceStatus[inst.status]}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 py-3 text-[13px]">
                <div className="min-w-0">
                  <dt className="text-xs text-fg-3">{t('terminalPage.address')}</dt>
                  <dd className="truncate font-mono text-[12.5px] text-fg">{connectAddress(inst) ?? '—'}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-fg-3">{t('common.region')}</dt>
                  <dd className="flex min-w-0 items-center gap-1.5 text-fg">
                    {inst.country && <CountryFlag code={inst.country} className="h-3 w-4.5 shrink-0" />}
                    <span className="truncate">{inst.region}</span>
                  </dd>
                </div>
                <div className="col-span-2 min-w-0">
                  <dt className="text-xs text-fg-3">{t('terminalPage.spec')}</dt>
                  <dd className="truncate text-fg">
                    {L.instanceType[inst.type]} · {formatCores(inst.cpu)} · {formatMemory(inst.memory)} · {inst.disk} GB
                  </dd>
                </div>
              </dl>
              {!canConnect(inst) && <p className="border-t border-line bg-surface-2 px-3.5 py-2 text-xs text-fg-3">{t('terminal.needRunning')}</p>}
            </div>
          )}
          {/* 使用提示 */}
          <ul className="space-y-1 text-xs leading-relaxed text-fg-3">
            <li className="flex gap-2">
              <Keyboard className="mt-0.5 size-3.5 shrink-0" />
              {t('terminalPage.tipKeys')}
            </li>
            <li className="flex gap-2">
              <Layers className="mt-0.5 size-3.5 shrink-0" />
              {t('terminalPage.tipTabs')}
            </li>
          </ul>
        </div>
      )}
    </Modal>
  );
}

export default function TerminalPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const instances = useInstances();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [status, setStatus] = useState<Record<number, TerminalStatus>>({});
  const [picking, setPicking] = useState(false);
  const [full, setFull] = useState(false);
  const seq = useRef(0);
  const handles = useRef<Record<number, TerminalHandle | null>>({});
  const background = useTerminalBackground();

  const open = (inst: InstanceDTO) => {
    const key = ++seq.current;
    setSessions((s) => [...s, { key, inst, nonce: 0 }]);
    setActive(key);
    setPicking(false);
  };
  const close = (key: number) => {
    const idx = sessions.findIndex((s) => s.key === key);
    const next = sessions.filter((s) => s.key !== key);
    setSessions(next);
    // 关闭当前标签时切换到相邻的会话
    if (active === key) setActive(next[Math.min(idx, next.length - 1)]?.key ?? null);
  };
  const reconnect = (key: number) => setSessions((list) => list.map((s) => (s.key === key ? { ...s, nonce: s.nonce + 1 } : s)));

  // 从其他页面带 ?instance=ID 进入时直接打开该实例的连接
  useEffect(() => {
    const id = Number(params.get('instance'));
    if (!id || !instances.data) return;
    const inst = instances.data.find((i) => i.id === id);
    if (inst && canConnect(inst)) open(inst);
    const p = new URLSearchParams(params);
    p.delete('instance');
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances.data]);

  // 同一实例开了多个连接时在标签上加序号
  const label = (s: Session) => {
    const same = sessions.filter((x) => x.inst.id === s.inst.id);
    return same.length > 1 ? `${s.inst.hostname} #${same.indexOf(s) + 1}` : s.inst.hostname;
  };
  const iconBtn = 'rounded p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white';
  const newButton = (
    <Button variant="primary" icon={<Plus />} onClick={() => setPicking(true)}>
      {t('terminalPage.new')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('nav.terminal')} description={t('terminalPage.desc')} actions={newButton} />
      {sessions.length === 0 ? (
        <Card>
          <Empty title={t('terminalPage.empty')} description={t('terminalPage.emptyDesc')} icon={<SquareTerminal />} action={newButton} />
        </Card>
      ) : (
        <div
          className={cn(
            'flex flex-col overflow-hidden text-neutral-200',
            full ? 'fixed inset-0 z-50' : 'h-[calc(100dvh-13rem)] min-h-96 rounded-lg ring-1 ring-black/10',
          )}
        >
          {/* 会话标签栏 */}
          <div className="flex items-center border-b border-neutral-800 bg-[#0a0a0a]">
            <div className="scrollbar-thin flex min-w-0 flex-1 overflow-x-auto" role="tablist">
              {sessions.map((s) => {
                const st = status[s.key] ?? 'connecting';
                return (
                  <div
                    key={s.key}
                    role="tab"
                    aria-selected={s.key === active}
                    tabIndex={0}
                    onClick={() => setActive(s.key)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setActive(s.key)}
                    className={cn(
                      'group flex shrink-0 cursor-pointer items-center gap-2 border-r border-neutral-800 py-2.5 pr-2 pl-3.5 text-[13px] outline-none',
                      s.key === active ? 'bg-neutral-900 text-white' : 'text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200',
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', st === 'connected' ? 'bg-success' : st === 'connecting' ? 'animate-pulse bg-warning' : 'bg-neutral-600')} />
                    <span className="max-w-40 truncate">{label(s)}</span>
                    <button
                      type="button"
                      aria-label={t('common.close')}
                      onClick={(e) => {
                        e.stopPropagation();
                        close(s.key);
                      }}
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-white"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              <button type="button" aria-label={t('terminalPage.new')} title={t('terminalPage.new')} onClick={() => setPicking(true)} className={cn(iconBtn, 'mx-1.5 self-center')}>
                <Plus className="size-4" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1 px-2">
              {active !== null && <TerminalSettings handle={() => handles.current[active] ?? null} name={sessions.find((s) => s.key === active)?.inst.hostname ?? 'terminal'} />}
              <button type="button" aria-label={t('terminal.reconnect')} title={t('terminal.reconnect')} onClick={() => active !== null && reconnect(active)} className={iconBtn}>
                <RefreshCw className="size-4" />
              </button>
              <button
                type="button"
                aria-label={full ? t('terminal.exitFullscreen') : t('terminal.fullscreen')}
                title={full ? t('terminal.exitFullscreen') : t('terminal.fullscreen')}
                onClick={() => setFull(!full)}
                className={iconBtn}
              >
                {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </button>
            </div>
          </div>
          {/* 所有会话保持挂载，切换标签不会断开连接 */}
          <div className="relative min-h-0 flex-1" style={{ background }}>
            {sessions.map((s) => (
              <div key={s.key} className={cn('absolute inset-0', s.key !== active && 'invisible')}>
                <WebTerminal
                  key={s.nonce}
                  handle={(h) => {
                    handles.current[s.key] = h;
                  }}
                  url={`/instances/${s.inst.id}/terminal`}
                  active={s.key === active}
                  onReconnect={() => reconnect(s.key)}
                  onStatus={(st) => setStatus((m) => ({ ...m, [s.key]: st }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      <NewSessionDialog open={picking} onClose={() => setPicking(false)} onConnect={open} />
    </>
  );
}
