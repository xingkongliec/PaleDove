import { Menu } from '@base-ui/react/menu';
import { Check } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  separator?: boolean;
  /** 选中标记（语言、主题等单选菜单） */
  checked?: boolean;
  /** 分组标题 */
  heading?: boolean;
}

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  header,
  className,
}: {
  trigger: ReactElement;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  header?: ReactNode;
  className?: string;
}) {
  const visible = items.filter((i) => !i.hidden);
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner className="z-[70] outline-none" sideOffset={6} align={align}>
          <Menu.Popup
            className={cn(
              'popup-anim min-w-40 rounded-lg border border-line bg-surface p-1 text-[13px] shadow-card outline-none',
              className,
            )}
          >
            {header}
            {visible.map((item, i) =>
              item.separator ? (
                <Menu.Separator key={i} className="mx-1 my-1 h-px bg-line" />
              ) : item.heading ? (
                <div key={i} className="px-2.5 pt-2 pb-1 text-xs text-fg-4">
                  {item.label}
                </div>
              ) : (
                <Menu.Item
                  key={i}
                  disabled={item.disabled}
                  onClick={item.onClick}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 outline-none select-none transition-colors duration-100 data-disabled:cursor-not-allowed data-disabled:opacity-40 data-highlighted:bg-surface-3',
                    item.danger ? 'text-danger-text' : 'text-fg',
                  )}
                >
                  {item.icon && <span className="flex size-4 items-center justify-center text-current opacity-70 [&>svg]:size-4">{item.icon}</span>}
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.checked && <Check className="size-3.5 text-fg" />}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
