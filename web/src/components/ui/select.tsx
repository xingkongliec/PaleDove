import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

export interface SelectOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** 下拉列表中显示在名称下方的一行说明；已选中时触发框只显示名称 */
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  value: T | null;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

const triggerClass = (className?: string) =>
  cn(
    'group flex h-8.5 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 text-left text-sm text-fg outline-none transition-[border-color,box-shadow] duration-150',
    'hover:not-data-disabled:border-line-strong focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-60 data-popup-open:border-focus data-popup-open:ring-3 data-popup-open:ring-ring',
    className,
  );

function TriggerIcon() {
  return (
    <BaseSelect.Icon className="shrink-0 text-fg-4">
      <ChevronDown className="size-3.5 transition-transform duration-200 ease-smooth group-data-popup-open:rotate-180" />
    </BaseSelect.Icon>
  );
}

/** 下拉列表：单选与多选共用 */
function OptionList<T extends string | number>({ options }: { options: SelectOption<T>[] }) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner className="z-[70] outline-none" sideOffset={4} alignItemWithTrigger={false}>
        <BaseSelect.Popup
          className={cn(
            // 与输入框同宽，说明文字过长时换行，不伸出所在的表单或弹窗；输入框很窄时（如版本选择）最多放宽到 16rem
            'popup-anim min-w-[var(--anchor-width)] max-w-[max(var(--anchor-width),16rem)] overflow-hidden rounded-lg border border-line bg-surface p-1 text-[13px] shadow-card',
          )}
        >
          <BaseSelect.List className="scrollbar-thin max-h-[min(var(--available-height),18rem)] overflow-y-auto">
            {options.map((o) => (
              <BaseSelect.Item
                key={String(o.value)}
                value={o.value}
                disabled={o.disabled}
                className={cn(
                  'grid cursor-pointer grid-cols-[1fr_1rem] items-center gap-3 rounded-md pr-2 pl-2.5 outline-none select-none transition-colors duration-100 data-disabled:cursor-not-allowed data-disabled:opacity-40 data-highlighted:bg-surface-3 data-selected:font-medium',
                  o.description ? 'py-2' : 'py-1.5',
                )}
              >
                <div className="min-w-0">
                  <BaseSelect.ItemText className="block min-w-0">{o.label}</BaseSelect.ItemText>
                  {o.description && <div className="mt-0.5 text-xs leading-relaxed font-normal text-fg-3">{o.description}</div>}
                </div>
                <BaseSelect.ItemIndicator className="text-fg">
                  <Check className="size-3.5" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function Select<T extends string | number>({ value, onChange, options, placeholder, disabled, className, ...rest }: SelectProps<T>) {
  const t = useT();
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => v !== null && onChange(v as T)}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled}
    >
      <BaseSelect.Trigger aria-label={rest['aria-label']} className={triggerClass(className)}>
        <BaseSelect.Value className="truncate data-placeholder:text-fg-4" placeholder={placeholder ?? t('common.select')} />
        <TriggerIcon />
      </BaseSelect.Trigger>
      <OptionList options={options} />
    </BaseSelect.Root>
  );
}

export interface MultiSelectProps<T extends string | number> extends Omit<SelectProps<T>, 'value' | 'onChange'> {
  value: T[];
  onChange: (value: T[]) => void;
}

/** 多选下拉框：选项可勾选多个，触发框里列出已选的名称；一个都没选时显示 placeholder */
export function MultiSelect<T extends string | number>({ value, onChange, options, placeholder, disabled, className, ...rest }: MultiSelectProps<T>) {
  const t = useT();
  const picked = options.filter((o) => value.includes(o.value));
  return (
    <BaseSelect.Root
      multiple
      value={value}
      onValueChange={(v) => onChange(options.map((o) => o.value).filter((x) => (v as T[] | null)?.includes(x)))}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled}
    >
      <BaseSelect.Trigger aria-label={rest['aria-label']} className={triggerClass(className)}>
        <BaseSelect.Value className="min-w-0 truncate">
          {() =>
            picked.length ? (
              picked.map((o, i) => (
                <span key={String(o.value)}>
                  {i > 0 && '、'}
                  {o.label}
                </span>
              ))
            ) : (
              <span className="text-fg-4">{placeholder ?? t('common.select')}</span>
            )
          }
        </BaseSelect.Value>
        <TriggerIcon />
      </BaseSelect.Trigger>
      <OptionList options={options} />
    </BaseSelect.Root>
  );
}
