import { Toast } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { toastManager } from '@/lib/toast';

function ToastList() {
  const t = useT();
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      className="toast-anim pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border border-line bg-surface px-4 py-3 text-fg shadow-card select-none sm:w-80"
    >
      <ToastIcon type={item.type} />
      <Toast.Content className="min-w-0 flex-1">
        <Toast.Title className="text-[13px] font-medium" />
        <Toast.Description className="mt-0.5 text-xs break-words whitespace-pre-wrap text-fg-3" />
      </Toast.Content>
      <Toast.Close aria-label={t('common.close')} className="text-fg-4 transition-colors hover:text-fg-2">
        <X className="size-3.5" />
      </Toast.Close>
    </Toast.Root>
  ));
}

function ToastIcon({ type }: { type?: string }) {
  if (type === 'success') return <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />;
  if (type === 'error') return <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />;
  if (type === 'warning') return <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />;
  return <Info className="mt-0.5 size-4 shrink-0 text-fg-3" />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed top-4 right-4 z-[100] flex w-[calc(100vw-2rem)] flex-col overflow-x-clip sm:w-80">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
