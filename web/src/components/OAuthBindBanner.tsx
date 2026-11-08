// 控制台顶部提示：管理员要求绑定指定的第三方账号后才能购买实例，当前用户还没有绑定
import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';

/** 账号设置里绑定 / 解绑后派发，提示条据此刷新 */
export const OAUTH_CHANGED = 'pd:oauth-changed';

interface Requirement {
  mode: 'any' | 'all';
  missing: Array<{ id: string; name: string }>;
  satisfied: boolean;
}

export function OAuthBindBanner() {
  const { t } = useI18n();
  const { data, refetch } = useQuery({ queryKey: ['oauth-requirement'], queryFn: () => api.get<Requirement>('/auth/oauth/requirement'), staleTime: 60_000 });
  const { pathname, search } = useLocation();
  // 账号设置里绑定 / 解绑后刷新
  useEffect(() => {
    const on = () => void refetch();
    window.addEventListener(OAUTH_CHANGED, on);
    return () => window.removeEventListener(OAUTH_CHANGED, on);
  }, [refetch]);
  if (!data || data.satisfied) return null;
  const onPage = pathname === '/account' && search.includes('tab=connections');
  const names = data.missing.map((p) => p.name).join(data.mode === 'all' ? t('account.connections.joinAll') : t('account.connections.joinAny'));
  return (
    <div role="status" className="fade-in mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/30 bg-warning-soft px-4 py-2 text-[13px] text-warning-text">
      <Link2 className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t('account.connections.banner', { names })}</span>
      {!onPage && (
        <Link to="/account?tab=connections" className="shrink-0 font-medium underline">
          {t('account.connections.goBind')}
        </Link>
      )}
    </div>
  );
}
