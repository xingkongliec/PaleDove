import { Field } from '@base-ui/react/field';
import { Input as BaseInput } from '@base-ui/react/input';
import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

export const inputClass =
  'h-8.5 w-full min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-4 outline-none ' +
  'transition-[border-color,box-shadow,background-color] duration-150 hover:not-disabled:border-line-strong focus:border-focus focus:ring-3 focus:ring-ring hover:focus:border-focus ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-4 read-only:bg-surface-2 data-invalid:border-danger data-invalid:focus:ring-danger/15';

export function Input({ className, ...props }: ComponentProps<typeof BaseInput>) {
  return <BaseInput className={cn(inputClass, className as string)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(inputClass, 'h-auto min-h-20 py-2 leading-relaxed', className)} {...props} />;
}

/** 带前后缀的输入框：如 “https://” 或 “GiB” */
export function InputGroup({ prefix, suffix, className, ...props }: ComponentProps<typeof BaseInput> & { prefix?: ReactNode; suffix?: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 items-stretch">
      {prefix && (
        <span className="inline-flex items-center rounded-l-md border border-r-0 border-line bg-surface-2 px-2.5 text-xs text-fg-3">
          {prefix}
        </span>
      )}
      <BaseInput className={cn(inputClass, prefix && 'rounded-l-none', suffix && 'rounded-r-none', className as string)} {...props} />
      {suffix && (
        <span className="inline-flex items-center rounded-r-md border border-l-0 border-line bg-surface-2 px-2.5 text-xs whitespace-nowrap text-fg-3">
          {suffix}
        </span>
      )}
    </div>
  );
}

/** 密码输入框：右侧按钮切换明文显示 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<typeof BaseInput>, 'type'>) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative w-full min-w-0">
      <BaseInput type={visible ? 'text' : 'password'} className={cn(inputClass, 'pr-10', className as string)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t('login.hidePassword') : t('login.showPassword')}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-fg-4 transition-colors hover:text-fg-2 [&_svg]:size-4"
      >
        {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </button>
    </div>
  );
}

export interface FormFieldProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** 表单项：标签 + 控件 + 说明/错误 */
export function FormField({ label, description, error, required, className, children }: FormFieldProps) {
  return (
    <Field.Root invalid={!!error} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && (
        <Field.Label className="text-[13px] font-medium text-fg-2">
          {required && <span className="mr-0.5 text-danger-text">*</span>}
          {label}
        </Field.Label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger-text">{error}</p>
      ) : description ? (
        <Field.Description className="text-xs leading-relaxed text-fg-3">{description}</Field.Description>
      ) : null}
    </Field.Root>
  );
}
