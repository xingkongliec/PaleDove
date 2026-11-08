import RFB from '@novnc/novnc';
import { useEffect, useRef, useState } from 'react';
import { isVmType } from '@/shared';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useInstanceApiPath, useMarketLocked, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { WebTerminal, type TerminalStatus } from './Terminal';

export default function Console({ inst }: { inst: AnyInstance }) {
  const { t } = useI18n();
  const path = useInstanceApiPath(inst.id);
  const locked = useMarketLocked(inst);
  const [mode, setMode] = useState<'console' | 'vga'>(isVmType(inst.type) ? 'vga' : 'console');
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const display = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const enabled = inst.status === 'RUNNING' && !locked;
  useEffect(() => {
    if (!enabled || mode !== 'vga' || !display.current) return;
    setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new RFB(display.current, `${proto}://${location.host}/api${path}/console?type=vga`);
    client.scaleViewport = true;
    client.resizeSession = false;
    client.addEventListener('connect', () => setStatus('connected'));
    client.addEventListener('disconnect', () => setStatus('closed'));
    rfb.current = client;
    return () => { client.disconnect(); rfb.current = null; };
  }, [enabled, mode, nonce, path]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={mode} onChange={setMode} className="w-48" options={[
          { value: 'console', label: t('console.serial'), description: t('console.serialDesc') },
          ...(isVmType(inst.type) ? [{ value: 'vga' as const, label: t('console.vnc'), description: t('console.vncDesc') }] : []),
        ]} />
        <Button disabled={!enabled} onClick={() => setNonce((v) => v + 1)}>{t('terminal.reconnect')}</Button>
        {mode === 'vga' && <Button disabled={status !== 'connected'} onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl Alt Del</Button>}
        <span className="text-xs text-fg-3">{enabled ? t(`terminal.status.${status}`) : t('terminal.needRunning')}</span>
      </div>
      <Alert>{t('console.hint')}</Alert>
      {enabled && <div className="h-[65dvh] min-h-80 overflow-hidden rounded-lg border border-line bg-surface-2">
        {mode === 'vga' ? <div ref={display} className="h-full w-full" /> :
          <WebTerminal key={nonce} url={`${path}/console`} onStatus={setStatus} />}
      </div>}
    </div>
  );
}
