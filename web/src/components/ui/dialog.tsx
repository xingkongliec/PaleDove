import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
}

const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-[28rem]', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl', '2xl': 'sm:max-w-6xl' };

/** 对话框：桌面端居中，手机端为底部抽屉；内容区域独立滚动，页脚始终可见 */
export function Modal({ open, onOpenChange, title, description, children, footer, size = 'md' }: ModalProps) {
  const t = useT();
  // 关闭时父组件常常立刻清空表单状态，而弹窗还在播放淡出动画：保留打开期间最后一次的内容，避免淡出时出现空壳
  const shown = useRef({ title, description, children, footer });
  if (open) shown.current = { title, description, children, footer };
  const s = shown.current;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop-anim fixed inset-0 z-50 bg-overlay" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
          <Dialog.Popup
            className={cn(
              'modal-anim relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl bg-surface text-fg shadow-card ring-1 ring-line outline-none sm:max-h-[88dvh] sm:rounded-xl',
              widths[size],
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-3.5">
              <div className="min-w-0">
                <Dialog.Title className="text-[15px] leading-6 font-semibold">{s.title}</Dialog.Title>
                {s.description && <Dialog.Description className="mt-0.5 text-[13px] leading-relaxed text-fg-3">{s.description}</Dialog.Description>}
              </div>
              <Dialog.Close
                aria-label={t('common.close')}
                className="-mr-1 rounded p-1 text-fg-4 transition-[color,background-color,scale] hover:bg-surface-3 hover:text-fg-2 active:scale-90"
              >
                <X className="size-4" />
              </Dialog.Close>
            </div>
            {s.children && <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{s.children}</div>}
            {s.footer && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {s.footer}
              </div>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
