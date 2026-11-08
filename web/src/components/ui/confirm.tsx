import { AlertDialog } from '@base-ui/react/alert-dialog';
import { CircleAlert } from 'lucide-react';
import { createContext, use, useCallback, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button } from './button';
import { Input } from './input';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** 要求用户输入该文本才能确认（用于删除等高危操作） */
  requireText?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t, rich } = useI18n();
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    setOpts(o);
    setTyped('');
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  };

  const blocked = !!opts?.requireText && typed !== opts.requireText;

  return (
    <ConfirmContext value={confirm}>
      {children}
      <AlertDialog.Root open={open} onOpenChange={(o) => !o && finish(false)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="backdrop-anim fixed inset-0 z-[60] bg-overlay" />
          <AlertDialog.Viewport className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
            <AlertDialog.Popup className="modal-anim w-full rounded-t-xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-fg shadow-card ring-1 ring-line outline-none sm:max-w-md sm:rounded-xl">
              <div className="flex gap-3">
                <CircleAlert className={opts?.danger ? 'mt-0.5 size-5 shrink-0 text-danger' : 'mt-0.5 size-5 shrink-0 text-warning'} />
                <div className="min-w-0 flex-1">
                  <AlertDialog.Title className="text-[15px] leading-6 font-semibold break-words">{opts?.title}</AlertDialog.Title>
                  {opts?.description && (
                    <AlertDialog.Description render={<div />} className="mt-1.5 text-[13px] leading-relaxed text-fg-2">
                      {opts.description}
                    </AlertDialog.Description>
                  )}
                  {opts?.requireText && (
                    <div className="mt-4 space-y-1.5">
                      <p className="text-xs text-fg-2">
                        {rich('common.typeToConfirm', {
                          text: <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-fg">{opts.requireText}</code>,
                        })}
                      </p>
                      <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button onClick={() => finish(false)}>{opts?.cancelText ?? t('common.cancel')}</Button>
                <Button variant={opts?.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => finish(true)}>
                  {opts?.confirmText ?? t('common.confirm')}
                </Button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = use(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside ConfirmProvider');
  return fn;
}
