import { Button as BaseButton } from '@base-ui/react/button';
import { LoaderCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'soft' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const base =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium select-none outline-none ' +
  'transition-[color,background-color,border-color,box-shadow,scale,opacity] duration-150 ease-smooth enabled:active:scale-[0.97] ' +
  'disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50 ' +
  'focus-visible:ring-3 focus-visible:ring-ring [&_svg]:shrink-0';

const variants: Record<ButtonVariant, string> = {
  primary: 'border border-primary bg-primary text-primary-fg shadow-xs hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover',
  secondary: 'border border-line bg-surface text-fg shadow-xs hover:not-disabled:border-line-strong hover:not-disabled:bg-surface-2',
  soft: 'border border-transparent bg-surface-3 text-fg hover:not-disabled:bg-surface-4',
  ghost: 'border border-transparent text-fg-2 hover:not-disabled:bg-surface-3 hover:not-disabled:text-fg',
  danger: 'border border-danger bg-danger text-danger-fg shadow-xs hover:not-disabled:border-danger-hover hover:not-disabled:bg-danger-hover',
  'danger-ghost': 'border border-transparent text-danger-text hover:not-disabled:bg-danger-soft',
  success: 'border border-success-solid bg-success-solid text-success-fg shadow-xs hover:not-disabled:border-success-solid-hover hover:not-disabled:bg-success-solid-hover',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
  md: 'h-8.5 px-3.5 text-sm [&_svg]:size-4',
  lg: 'h-10 px-5 text-sm [&_svg]:size-4',
  icon: 'size-8.5 [&_svg]:size-4',
  'icon-sm': 'size-7 [&_svg]:size-3.5',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends Omit<ComponentProps<typeof BaseButton>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingText?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

function LoadingIcon({ active = true, className }: { active?: boolean; className?: string }) {
  return <span className={cn('inline-flex items-center justify-center', active && 'button-loading-icon', className)} aria-hidden><LoaderCircle className={active ? 'animate-spin' : undefined} /></span>;
}

export function Button({ variant = 'secondary', size = 'md', loading, loadingText, icon, className, children, disabled, ...props }: ButtonProps) {
  return (
    <BaseButton
      type="button"
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, cn('relative', className))}
      {...props}
    >
      {loadingText ? (
        <span className="inline-grid items-center justify-items-center">
          <span className={cn('col-start-1 row-start-1 inline-flex items-center gap-1.5', loading && 'invisible')} aria-hidden={loading || undefined}>
            {icon}{children}
          </span>
          <span className={cn('col-start-1 row-start-1 inline-flex items-center gap-1.5', !loading && 'invisible')} aria-hidden={!loading || undefined}>
            <LoadingIcon active={!!loading} />{loadingText}
          </span>
        </span>
      ) : (
        <>
          {loading && icon ? (
            <span className="relative inline-flex items-center justify-center">
              <span className="opacity-0">{icon}</span>
              <LoadingIcon className="absolute" />
            </span>
          ) : icon}
          {loading && !icon ? <span className="opacity-0">{children}</span> : children}
          {loading && !icon && <LoadingIcon className="absolute" />}
        </>
      )}
    </BaseButton>
  );
}

export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...props
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, cn('active:scale-[0.97]', className))} {...props}>
      {icon}
      {children}
    </Link>
  );
}
