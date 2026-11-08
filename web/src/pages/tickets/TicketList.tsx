// 工单列表（用户与管理员共用）：状态标签带数量，搜索与分类 / 优先级筛选在同一行；
// 列表为收件箱样式，等我方处理的工单（管理员：待处理；用户：已回复）加粗并在左侧标点
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, LifeBuoy, MessageSquare, Paperclip, Plus, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { TICKET_STATUSES, type Paginated, type TicketDTO, type TicketStatus } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { UserAvatar } from '@/components/UserAvatar';
import { Button, LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, Card, Empty, ErrorState, Skeleton } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, fromNow } from '@/lib/format';
import { usePublicConfig } from '@/lib/queries';
import { categoryOptions, PriorityBadge, priorityOptions, TicketStatusBadge } from './parts';

/** 列表中的一行：工单号与标题、最后一条回复预览；右侧状态、计数与时间 */
function TicketRow({ ticket, admin, to }: { ticket: TicketDTO; admin: boolean; to: string }) {
  const t = useT();
  const hot = ticket.status === (admin ? 'OPEN' : 'REPLIED');
  const closed = ticket.status === 'CLOSED';
  const who = ticket.lastReply?.isAdmin ? t('ticket.support') : t(admin ? 'ticket.user' : 'ticket.me');
  return (
    <li>
      <Link to={to} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60 sm:items-center">
        {/* 等我方处理的工单标点 */}
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full sm:mt-0', hot ? 'bg-warning' : 'bg-transparent')} title={hot ? t(admin ? 'ticket.hotAdmin' : 'ticket.hotUser') : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0 font-mono text-xs text-fg-4">#{ticket.number}</span>
            <span className={cn('min-w-0 truncate text-[14px]', hot ? 'font-semibold text-fg' : closed ? 'text-fg-3' : 'font-medium text-fg')}>{ticket.subject}</span>
            {(ticket.priority === 'HIGH' || ticket.priority === 'URGENT') && <PriorityBadge value={ticket.priority} />}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
            <span className="shrink-0 rounded bg-surface-3 px-1.5 py-px text-[11px] text-fg-2">{t(`ticket.category.${ticket.category}`)}</span>
            {admin && (
              <span className="inline-flex shrink-0 items-center gap-1 text-fg-2">
                <UserAvatar avatar={ticket.user.avatar} name={ticket.user.name || ticket.user.username} size={16} />
                {ticket.user.name || ticket.user.username}
              </span>
            )}
            {admin && <span className="text-fg-4">·</span>}
            <span className="min-w-0 truncate">{ticket.lastReply ? `${who}：${ticket.lastReply.content.replace(/\s+/g, ' ')}` : t('ticket.noMessages')}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-4">
          <TicketStatusBadge value={ticket.status} />
          <span className="hidden items-center gap-3 text-xs text-fg-3 md:inline-flex">
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3" />
              {ticket.counts.messages}
            </span>
            {ticket.counts.attachments > 0 && (
              <span className="inline-flex items-center gap-1">
                <Paperclip className="size-3" />
                {ticket.counts.attachments}
              </span>
            )}
          </span>
          <span className="tabular w-16 text-right text-xs text-fg-3 sm:w-20" title={formatDate(ticket.lastReplyAt, 'YYYY-MM-DD HH:mm:ss')}>
            {fromNow(ticket.lastReplyAt)}
          </span>
          <ChevronRight className="hidden size-4 text-fg-4 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2 sm:block" />
        </div>
      </Link>
    </li>
  );
}

export function TicketList({ admin }: { admin: boolean }) {
  const t = useT();
  const { data: site } = usePublicConfig();
  const base = admin ? '/admin/tickets' : '/tickets';
  const listPath = admin ? base : '/console/tickets';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // 管理员默认看待处理
  const [status, setStatus] = useState<TicketStatus | 'ALL'>(admin ? 'OPEN' : 'ALL');
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['tickets', 'list', admin, page, pageSize, status, priority, category, q],
    queryFn: () => api.get<Paginated<TicketDTO>>(base, { page, pageSize, status: status === 'ALL' ? '' : status, priority, category, q }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const stats = useQuery({ queryKey: ['tickets', 'stats', admin], queryFn: () => api.get<Record<TicketStatus, number>>(`${base}/stats`), refetchInterval: 30_000 });
  const total = Object.values(stats.data ?? {}).reduce((sum, n) => sum + n, 0);
  const statuses: Array<TicketStatus | 'ALL'> = admin ? [...TICKET_STATUSES, 'ALL'] : ['ALL', ...TICKET_STATUSES];
  const filtered = !!(q || priority || category || status !== 'ALL');
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };
  const create =
    !admin && site?.allowTickets ? (
      <LinkButton to="/console/tickets/new" variant="primary" icon={<Plus />}>
        {t('ticket.new')}
      </LinkButton>
    ) : undefined;
  const items = list.data?.items;

  return (
    <div>
      <PageHeader
        title={t('ticket.title')}
        description={t(admin ? 'ticket.adminDesc' : 'ticket.listDesc')}
        actions={
          <>
            <Button
              icon={<RefreshCw />}
              loading={list.isFetching}
              onClick={() => {
                void list.refetch();
                void stats.refetch();
              }}
            >
              {t('common.refresh')}
            </Button>
            {create}
          </>
        }
      />
      {site?.allowTickets === false && <Alert className="mb-4">{t(admin ? 'ticket.adminDisabled' : 'ticket.disabled')}</Alert>}
      {stats.error && <Alert tone="warning" className="mb-4">{stats.error.message}</Alert>}

      <Card className="overflow-hidden">
        {/* 状态标签 */}
        <TabBar<TicketStatus | 'ALL'>
          value={status}
          onChange={reset(setStatus)}
          className="border-b border-line"
          listClassName="border-b-0 px-3 py-2"
          items={statuses.map((v) => ({ value: v, label: v === 'ALL' ? t('ticket.all') : t(`ticket.status.${v}`), count: stats.data ? (v === 'ALL' ? total : (stats.data[v] ?? 0)) : null }))}
        />
        {/* 搜索与筛选 */}
        <form
          className="grid gap-2 border-b border-line px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_9rem]"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(input.trim());
            setPage(1);
          }}
        >
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <Input
              className="pl-9"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // 清空搜索框时立即恢复全部
                if (!e.target.value.trim() && q) reset(setQ)('');
              }}
              placeholder={t(admin ? 'ticket.adminSearch' : 'ticket.search')}
              aria-label={t('common.search')}
            />
          </div>
          <Select value={category} onChange={reset(setCategory)} options={[{ value: '', label: t('ticket.allCategories') }, ...categoryOptions(t)]} aria-label={t('ticket.category')} />
          <Select value={priority} onChange={reset(setPriority)} options={[{ value: '', label: t('ticket.allPriorities') }, ...priorityOptions(t)]} aria-label={t('ticket.priority')} />
        </form>

        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !items ? (
          <div className="space-y-px">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-none" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Empty
            icon={<LifeBuoy />}
            title={t(filtered ? (admin && status === 'OPEN' && !q && !priority && !category ? 'ticket.noPending' : 'ticket.noMatch') : 'ticket.empty')}
            description={!admin && !filtered ? t('ticket.emptyDesc') : undefined}
            action={!filtered ? create : undefined}
          />
        ) : (
          <ul className={cn('divide-y divide-line transition-opacity', list.isPlaceholderData && 'opacity-60')}>
            {items.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} admin={admin} to={`${listPath}/${ticket.id}`} />
            ))}
          </ul>
        )}
        {list.data && list.data.total > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={list.data.total}
            onChange={setPage}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
          />
        )}
      </Card>
    </div>
  );
}
