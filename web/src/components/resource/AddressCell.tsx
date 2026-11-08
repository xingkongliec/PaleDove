// 连接地址：宿主机国旗 + 脱敏地址（眼睛图标显示完整地址）+ 复制（总是复制完整地址）
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { CountryFlag, useCountryName } from '@/components/country';
import { CopyButton } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

/** 脱敏：IPv4 保留前两段，IPv6 保留前两组，端口保留 */
export function maskAddress(addr: string): string {
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+(:\d+)?$/.exec(addr);
  if (v4) return `${v4[1]}.${v4[2]}.*.*${v4[3] ?? ''}`;
  const v6 = addr.replace(/^\[|\](:\d+)?$/g, '').split(':');
  if (v6.length > 2) return `${v6.slice(0, 2).join(':')}:*:*`;
  return addr;
}

/** 列表中的连接地址单元格；country 为宿主机国家代码 */
export function AddressCell({ address, country, className }: { address: string | null; country?: string; className?: string }) {
  const t = useT();
  const countryName = useCountryName();
  // 默认脱敏，每个地址单独切换
  const [shown, setShown] = useState(false);
  if (!address) return <span className="text-fg-4">—</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} onClick={(e) => e.stopPropagation()}>
      {country && (
        <span title={countryName(country)} className="inline-flex shrink-0">
          <CountryFlag code={country} className="h-3.5 w-5" />
        </span>
      )}
      <span className="truncate font-mono text-xs text-fg-2 tabular-nums" translate="no">
        {shown ? address : maskAddress(address)}
      </span>
      <span className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => setShown(!shown)}
          aria-label={shown ? t('address.hide') : t('address.show')}
          title={shown ? t('address.hide') : t('address.show')}
          className="flex size-6 items-center justify-center rounded-md text-fg-4 transition-colors hover:bg-surface-3 hover:text-fg-2"
        >
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
        <CopyButton value={address} className="size-6 text-fg-4" />
      </span>
    </span>
  );
}
