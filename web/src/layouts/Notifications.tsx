import { Popover } from '@base-ui/react/popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, ChevronRight, Mail, Megaphone, Pin } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { AnnouncementDTO } from '../shared/index';
import type { MessagePage } from '@/pages/Notifications';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fromNow } from '@/lib/format';
import { usePublicConfig, useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';

/** 未读数显示：超过 99 显示 99+ */
const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/** 站内信与公告的已读操作（顶栏与通知中心共用） */
export function useNotificationRead() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['announcements'] });
  };
  const readMessages = useMutation({ mutationFn: (ids?: number[]) => api.post('/messages/read', ids ? { ids } : {}), onSuccess: refresh, onError: (e) => toast.fromError(e) });
  const readAnnouncements = useMutation({ mutationFn: (ids?: number[]) => api.post('/announcements/read', ids ? { ids } : {}), onSuccess: refresh, onError: (e) => toast.fromError(e) });
  const readAll = useMutation({
    mutationFn: () => Promise.all([api.post('/messages/read', {}), api.post('/announcements/read', {})]),
    onSuccess: refresh,
    onError: (e) => toast.fromError(e),
  });
  return { readMessages, readAnnouncements, readAll };
}

/**
 * 顶栏通知：最近的站内信与站点公告，铃铛上显示未读数量；每条点击后才标记已读，
 * 顶部「全部已读」一次标记全部；底部进入通知中心查看全部
 */
export function Notifications() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const admin = useLocation().pathname.startsWith('/admin');
  const { data: cfg } = usePublicConfig();
  const full = cfg?.maintenance?.state === 'active' && cfg.maintenance.scope === 'FULL' && !cfg.maintenance.exempt;
  const { data: me } = useMe();
  const enabled = !full || me?.role === 'ADMIN';
  const { data } = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<AnnouncementDTO[]>('/announcements'), staleTime: 60_000, refetchInterval: 120_000, enabled });
  const list = data ?? [];
  const msgs = useQuery({ queryKey: ['messages'], queryFn: () => api.get<MessagePage>('/messages', { page: 1, pageSize: 10 }), refetchInterval: 60_000, enabled });
  const messages = msgs.data?.items ?? [];
  const unreadMessages = msgs.data?.unread ?? 0;
  const unreadAnnouncements = list.filter((a) => !a.read).length;
  const unread = unreadMessages + unreadAnnouncements;
  const { readMessages, readAnnouncements, readAll } = useNotificationRead();
  // 站内信与公告合成一条时间线：置顶公告在最前，其余按时间从新到旧，最多显示 10 条
  const feed = [
    ...messages.map((m) => ({ key: 'm' + m.id, id: m.id, kind: 'message' as const, title: m.title, content: m.content, createdAt: m.createdAt, unread: !m.read, pinned: false })),
    ...list.map((a) => ({ key: 'a' + a.id, id: a.id, kind: 'announcement' as const, title: a.title, content: a.content, createdAt: a.createdAt, unread: !a.read, pinned: a.pinned })),
  ]
    .sort((x, y) => Number(y.pinned) - Number(x.pinned) || new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())
    .slice(0, 10);
  const markRead = (n: (typeof feed)[number]) => {
    if (!n.unread) return;
    if (n.kind === 'message') readMessages.mutate([n.id]);
    else readAnnouncements.mutate([n.id]);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={unread ? `${t('shell.notifications')} (${unread})` : t('shell.notifications')}
        title={t('shell.notifications')}
        className="relative flex size-8 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg data-popup-open:bg-surface-3"
      >
        <Bell className="size-[17px]" />
        {/* 未读数量 */}
        {unread > 0 && (
          <span className="tabular absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-danger-fg ring-2 ring-bg">
            {badgeText(unread)}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[70]">
          <Popover.Popup className="popup-anim w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-card outline-none">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Popover.Title className="text-[13px] font-semibold">{t('shell.notifications')}</Popover.Title>
                {unread > 0 && <span className="tabular rounded-full bg-danger-soft px-1.5 text-[11px] leading-[18px] font-medium text-danger-text">{t('notify.unreadN', { n: unread })}</span>}
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:text-fg-4"
                disabled={!unread || readAll.isPending}
                onClick={() => readAll.mutate()}
              >
                <CheckCheck className="size-3.5" />
                {t('notify.readAll')}
              </button>
            </div>
            <div className="scrollbar-thin max-h-[22rem] overflow-y-auto">
              {feed.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <Bell className="size-7 stroke-1 text-fg-4" />
                  <p className="text-[13px] text-fg-3">{t('shell.noNotifications')}</p>
                </div>
              ) : (
                <ul className="divide-y divide-line/70">
                  {feed.map((n) => (
                    <li key={n.key}>
                      {/* 点击一条才标记已读 */}
                      <button
                        type="button"
                        onClick={() => markRead(n)}
                        title={n.unread ? t('notify.clickToRead') : undefined}
                        className={cn('block w-full px-4 py-3 text-left transition-colors', n.unread ? 'bg-surface-2/60 hover:bg-surface-3/60' : 'cursor-default')}
                      >
                        <span className="flex items-center gap-1.5">
                          {n.pinned ? <Pin className="size-3 shrink-0 text-warning-icon" /> : n.kind === 'message' ? <Mail className="size-3 shrink-0 text-fg-3" /> : <Megaphone className="size-3 shrink-0 text-fg-3" />}
                          <span className={cn('min-w-0 flex-1 truncate text-[13px] text-fg', n.unread ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                          {n.unread && <span className="size-1.5 shrink-0 rounded-full bg-danger" />}
                          <span className="shrink-0 text-[11px] text-fg-4">{fromNow(n.createdAt)}</span>
                        </span>
                        <span className={cn('mt-1 line-clamp-4 block text-xs leading-relaxed whitespace-pre-line', n.unread ? 'text-fg-2' : 'text-fg-3')}>{n.content}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Link
              to={admin ? '/admin/notifications' : '/console/notifications'}
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-1 border-t border-line py-2.5 text-[13px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
            >
              {t('shell.allNotifications')}
              <ChevronRight className="size-3.5" />
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
