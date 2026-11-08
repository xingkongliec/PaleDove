// 通知中心：站内信（可标记已读、删除）与站点公告；用户和管理后台共用
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Mail, Megaphone, Pin, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AnnouncementDTO, MessageDTO, Paginated } from '../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Card, Empty, ErrorState, PageLoading, Switch } from '@/components/ui/misc';
import { Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useNotificationRead } from '@/layouts/Notifications';

export type MessagePage = Paginated<MessageDTO> & { unread: number };

/** 一条通知：标题行（图标、标题、时间、操作）+ 正文 */
function Row({
  icon,
  title,
  time,
  unread,
  actions,
  onRead,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  time: string;
  unread?: boolean;
  actions?: React.ReactNode;
  /** 未读时点击整条标记已读 */
  onRead?: () => void;
  children: string;
}) {
  return (
    <li
      className={cn('group px-4 py-3', unread && 'cursor-pointer bg-surface-2/60 transition-colors hover:bg-surface-3/50')}
      onClick={unread ? onRead : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-fg-3 [&>svg]:size-3.5">{icon}</span>
        <span className={cn('min-w-0 flex-1 truncate text-[13px] text-fg', unread ? 'font-semibold' : 'font-medium')}>{title}</span>
        {unread && <span className="size-1.5 shrink-0 rounded-full bg-danger" />}
        <span className="shrink-0 text-xs text-fg-4" title={formatDate(time, 'YYYY-MM-DD HH:mm:ss')}>
          {fromNow(time)}
        </span>
        {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
      </div>
      <p className="mt-1 pl-5.5 text-[13px] leading-relaxed break-words whitespace-pre-line text-fg-2">{children}</p>
    </li>
  );
}

const iconBtn = 'rounded p-1 text-fg-4 transition-colors hover:bg-surface-3 hover:text-fg [&>svg]:size-3.5';

function Messages() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const q = useQuery({
    queryKey: ['messages', 'page', filter, page, pageSize],
    queryFn: () => api.get<MessagePage>('/messages', { page, pageSize, unread: filter === 'unread' ? 'true' : undefined }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['messages'] });
  const read = useMutation({ mutationFn: (ids?: number[]) => api.post('/messages/read', ids ? { ids } : {}), onSuccess: refresh, onError: (e) => toast.fromError(e) });
  const remove = useMutation({
    mutationFn: (ids?: number[]) => api.post<{ deleted: number }>('/messages/delete', ids ? { ids } : {}),
    onSuccess: (r) => {
      toast.success(t('notify.deleted', { n: r.deleted }));
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoading />;
  const { items, unread, total } = q.data;

  return (
    <Card className="overflow-hidden">
      {/* 工具栏：左侧数量与「只看未读」开关，右侧批量操作 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <span className="text-[13px] text-fg-2">
          {t('notify.summary', { total })}
          {unread > 0 && <span className="text-fg-3"> · {t('notify.unreadN', { n: unread })}</span>}
        </span>
        <Switch
          checked={filter === 'unread'}
          onCheckedChange={(v) => {
            setFilter(v ? 'unread' : 'all');
            setPage(1);
          }}
          label={t('notify.onlyUnread')}
        />
        <div className="ml-auto flex gap-2">
          <Button size="sm" icon={<CheckCheck />} disabled={!unread} loading={read.isPending && !read.variables} onClick={() => read.mutate(undefined)}>
            {t('notify.readAll')}
          </Button>
          <Button
            size="sm"
            icon={<Trash2 />}
            onClick={async () => {
              if (await confirm({ title: t('notify.clearRead'), description: t('notify.clearReadDesc'), danger: true })) remove.mutate(undefined);
            }}
          >
            {t('notify.clearRead')}
          </Button>
        </div>
      </div>
      {items.length === 0 ? (
        <Empty icon={<Bell />} title={filter === 'unread' ? t('notify.noUnread') : t('notify.noMessages')} />
      ) : (
        <ul className="divide-y divide-line/70">
          {items.map((m) => (
            <Row
              key={m.id}
              icon={<Mail />}
              title={m.title}
              time={m.createdAt}
              unread={!m.read}
              onRead={() => read.mutate([m.id])}
              actions={
                <span className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                  {!m.read && (
                    <button type="button" className={iconBtn} title={t('notify.markRead')} aria-label={t('notify.markRead')} onClick={() => read.mutate([m.id])}>
                      <CheckCheck />
                    </button>
                  )}
                  <button type="button" className={cn(iconBtn, 'hover:text-danger-text')} title={t('common.delete')} aria-label={t('common.delete')} onClick={() => remove.mutate([m.id])}>
                    <Trash2 />
                  </button>
                </span>
              }
            >
              {m.content}
            </Row>
          ))}
        </ul>
      )}
      {total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          onPageSizeChange={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      )}
    </Card>
  );
}

function Announcements() {
  const t = useT();
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<AnnouncementDTO[]>('/announcements'), staleTime: 60_000 });
  const { readAnnouncements } = useNotificationRead();
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoading />;
  const unread = q.data.filter((a) => !a.read).length;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <span className="text-[13px] text-fg-2">
          {t('notify.announcementSummary', { total: q.data.length })}
          {unread > 0 && <span className="text-fg-3"> · {t('notify.unreadN', { n: unread })}</span>}
        </span>
        <Button size="sm" className="ml-auto" icon={<CheckCheck />} disabled={!unread} loading={readAnnouncements.isPending && !readAnnouncements.variables} onClick={() => readAnnouncements.mutate(undefined)}>
          {t('notify.readAll')}
        </Button>
      </div>
      {q.data.length === 0 ? (
        <Empty icon={<Megaphone />} title={t('notify.noAnnouncements')} />
      ) : (
        <ul className="divide-y divide-line/70">
          {q.data.map((a) => (
            <Row key={a.id} icon={a.pinned ? <Pin className="text-warning-icon" /> : <Megaphone />} title={a.title} time={a.createdAt} unread={!a.read} onRead={() => readAnnouncements.mutate([a.id])}>
              {a.content}
            </Row>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function NotificationsPage() {
  const t = useT();
  const [tab, setTab] = useState<'messages' | 'announcements'>('messages');
  const msgs = useQuery({ queryKey: ['messages'], queryFn: () => api.get<MessagePage>('/messages', { page: 1, pageSize: 10 }) });
  const anns = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<AnnouncementDTO[]>('/announcements'), staleTime: 60_000 });
  return (
    <>
      <PageHeader title={t('notify.title')} description={t('notify.desc')} />
      <TabBar
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          { value: 'messages', label: t('notify.messages'), count: msgs.data?.unread || null },
          { value: 'announcements', label: t('notify.announcements'), count: anns.data?.filter((a) => !a.read).length || null },
        ]}
      />
      {tab === 'messages' ? <Messages /> : <Announcements />}
    </>
  );
}
