// 工单详情：标题栏（状态、关闭 / 重新打开）、聊天式消息流（自己在右、对方在左）、底部回复框（可拖入附件）；右侧工单信息，管理员可修改状态 / 优先级 / 分类并删除
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, CircleCheck, LifeBuoy, Paperclip, RotateCcw, SendHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { TICKET_STATUSES, type TicketDetailDTO } from '../../shared/index';
import { UserAvatar } from '@/components/UserAvatar';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Textarea } from '@/components/ui/input';
import { Alert, Card, ErrorState, PageLoading, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Attachments, categoryOptions, FileChips, FileInput, PriorityBadge, priorityOptions, TicketStatusBadge, useAddFiles } from './parts';

const CONTENT_MAX = 20000;
type Message = TicketDetailDTO['messages'][number];

/**
 * 一条消息（聊天式）：自己的回复在右侧、对方在左侧；头像在外侧，名称与时间在气泡上方。
 * 附件在上、文字气泡在下；自己的气泡使用主色浅底，对方使用中性底色
 */
function MessageItem({ message, admin, first, base }: { message: Message; admin: boolean; first: boolean; base: string }) {
  const t = useT();
  const mine = message.isAdmin === admin;
  const name = mine ? t('ticket.me') : message.isAdmin ? t('ticket.support') : message.author.username;
  const avatar = message.author.avatar ? (
    <UserAvatar avatar={message.author.avatar} name={message.author.username} size={32} />
  ) : (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-2">
      <LifeBuoy className="size-4" />
    </span>
  );
  return (
    <article className={cn('flex items-start gap-2.5', mine && 'flex-row-reverse')}>
      <div className="shrink-0 pt-0.5">{avatar}</div>
      <div className={cn('flex min-w-0 max-w-[min(85%,42rem)] flex-col', mine ? 'items-end' : 'items-start')}>
        <header className={cn('mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5', mine && 'flex-row-reverse')}>
          <span className="truncate text-xs font-medium text-fg-2">{name}</span>
          {message.isAdmin && !mine && <Tag tone="primary">{t('ticket.support')}</Tag>}
          {!message.isAdmin && admin && <Tag>{t('ticket.user')}</Tag>}
          {first && <Tag>{t('ticket.firstMessage')}</Tag>}
          <time className="text-[11px] text-fg-4" dateTime={message.createdAt} title={formatDate(message.createdAt, 'YYYY-MM-DD HH:mm:ss')}>
            {fromNow(message.createdAt)}
          </time>
        </header>
        <div className={cn('flex max-w-full flex-col gap-2', mine ? 'items-end' : 'items-start')}>
          <Attachments list={message.attachments} base={base} align={mine ? 'end' : 'start'} />
          {message.content.trim() && (
            <div className={cn('max-w-full rounded-[14px] px-3.5 py-2.5', mine ? 'bg-primary-soft' : 'border border-line bg-surface-2/60')}>
              <p className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{message.content}</p>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/** 回复框：文本、附件（按钮选择或直接拖入），Ctrl + Enter 发送；管理员可回复并关闭 */
function Composer({ admin, busy, sending, onSend }: { admin: boolean; busy: boolean; sending: boolean; onSend: (v: { content: string; files: File[]; close: boolean }, done: () => void) => void }) {
  const t = useT();
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const add = useAddFiles(files, setFiles);
  const ok = !busy && !!content.trim();
  const send = (close: boolean) => {
    if (!ok) return;
    onSend({ content: content.trim(), files, close }, () => {
      setContent('');
      setFiles([]);
    });
  };
  return (
    <form
      className="relative border-t border-line p-3 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        send(false);
      }}
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!busy) add(e.dataTransfer.files);
      }}
    >
      <div className={cn('rounded-lg border border-line bg-surface transition-[border-color,box-shadow] focus-within:border-line-strong focus-within:ring-3 focus-within:ring-ring', drag && 'border-focus')}>
        <Textarea
          maxLength={CONTENT_MAX}
          rows={4}
          disabled={busy}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          aria-label={t('ticket.reply')}
          placeholder={t(admin ? 'ticket.adminReplyPlaceholder' : 'ticket.userReplyPlaceholder')}
          className="resize-y rounded-b-none border-0 bg-transparent shadow-none focus:ring-0 disabled:bg-transparent"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send(false);
            }
          }}
        />
        {files.length > 0 && (
          <div className="px-3 pb-2">
            <FileChips files={files} setFiles={setFiles} disabled={busy} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-2 py-1.5">
          <FileInput onFiles={add} disabled={busy}>
            {(open) => (
              <Button size="sm" variant="ghost" icon={<Paperclip />} disabled={busy} onClick={open} title={t('ticket.uploadHint')}>
                {t('ticket.attach')}
              </Button>
            )}
          </FileInput>
          <span className="mr-auto hidden text-[11px] text-fg-4 sm:inline">
            {t('ticket.keyboardHint')} · {content.length}/{CONTENT_MAX}
          </span>
          {admin && (
            <Button size="sm" disabled={!ok} onClick={() => send(true)}>
              {t('ticket.replyClose')}
            </Button>
          )}
          <Button type="submit" size="sm" variant="primary" loading={sending} disabled={!ok} icon={<SendHorizontal />}>
            {t('ticket.reply')}
          </Button>
        </div>
      </div>
      {/* 拖入文件时的提示层 */}
      {drag && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-lg border-2 border-dashed border-focus bg-surface/85 text-[13px] font-medium text-fg sm:inset-4">
          <Paperclip className="mr-1.5 size-4" />
          {t('ticket.dropHere')}
        </div>
      )}
    </form>
  );
}

/** 信息栏中的一行 */
function InfoRow({ label, children, stack }: { label: string; children: ReactNode; stack?: boolean }) {
  return (
    <div className={cn('text-[13px]', stack ? 'space-y-1' : 'flex min-h-8 items-center justify-between gap-3')}>
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className={cn('min-w-0 text-fg', !stack && 'text-right')}>{children}</dd>
    </div>
  );
}

export function TicketDetail({ admin, id }: { admin: boolean; id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const listPath = admin ? '/admin/tickets' : '/console/tickets';
  const base = `${admin ? '/admin/tickets' : '/tickets'}/${id}`;
  const bottom = useRef<HTMLDivElement>(null);
  const detail = useQuery({ queryKey: ['tickets', 'detail', admin, id], queryFn: () => api.get<TicketDetailDTO>(base), refetchInterval: 15_000 });
  const count = detail.data?.messages.length ?? 0;
  // 有新消息时滚动到底部
  useEffect(() => {
    if (count) bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [count]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tickets'] });
  const send = useMutation({
    mutationFn: (v: { content: string; files: File[]; close: boolean }) => {
      const form = new FormData();
      form.append('content', v.content);
      if (admin && v.close) form.append('close', '1');
      v.files.forEach((file) => form.append('files', file));
      return api.post(`${base}/messages`, form);
    },
    onSuccess: (_, v) => {
      refresh();
      toast.success(t(v.close ? 'ticket.sentClosed' : 'ticket.sent'));
    },
    onError: (error) => toast.fromError(error),
  });
  const change = useMutation({
    mutationFn: (body: Record<string, string>) => api.patch(base, body),
    onSuccess: () => {
      refresh();
      toast.success(t('ticket.updated'));
    },
    onError: (error) => toast.fromError(error),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(base),
    onSuccess: () => {
      refresh();
      toast.success(t('ticket.deleted'));
      navigate(listPath);
    },
    onError: (error) => toast.fromError(error),
  });

  if (!detail.data) return detail.error ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <PageLoading />;
  const ticket = detail.data;
  const busy = send.isPending || change.isPending || remove.isPending;
  const closed = ticket.status === 'CLOSED';
  const toggleClosed = async () => {
    if (!closed && !(await confirm({ title: t('ticket.closeTitle'), description: t('ticket.closeDesc') }))) return;
    change.mutate({ status: closed ? 'OPEN' : 'CLOSED' });
  };

  return (
    <div>
      {/* 标题栏 */}
      <div className="mb-4 flex flex-wrap items-start gap-3 border-b border-line pb-4">
        <LinkButton to={listPath} size="icon" aria-label={t('ticket.back')} title={t('ticket.back')} className="size-9 shrink-0">
          <ChevronLeft />
        </LinkButton>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg leading-7 font-bold tracking-tight break-words text-fg">{ticket.subject}</h1>
            <TicketStatusBadge value={ticket.status} />
            {ticket.priority !== 'NORMAL' && <PriorityBadge value={ticket.priority} />}
          </div>
          <div className="mt-0.5 text-xs text-fg-3">
            <span className="font-mono">#{ticket.number}</span> · {t(`ticket.category.${ticket.category}`)} · {formatDate(ticket.createdAt)}
          </div>
        </div>
        <Button disabled={busy} icon={closed ? <RotateCcw /> : <CircleCheck className="text-success-icon" />} onClick={() => void toggleClosed()}>
          {t(closed ? 'ticket.reopen' : admin ? 'ticket.close' : 'ticket.resolved')}
        </Button>
      </div>
      {detail.error && <Alert tone="warning" className="mb-4">{detail.error.message}</Alert>}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        {/* 消息流与回复框 */}
        <Card className="overflow-hidden">
          <div className="space-y-4 p-3 sm:p-4">
            {ticket.messages.map((message, index) => (
              <MessageItem key={message.id} message={message} admin={admin} first={index === 0} base={base} />
            ))}
            <div ref={bottom} />
          </div>
          {closed ? (
            <div className="border-t border-line p-3 sm:p-4">
              <Alert>
                {t('ticket.closeHint')}
                {ticket.closedAt && <span className="ml-2 text-fg-3">{formatDate(ticket.closedAt)}</span>}
              </Alert>
            </div>
          ) : (
            <Composer admin={admin} busy={busy} sending={send.isPending} onSend={(v, done) => send.mutate(v, { onSuccess: done })} />
          )}
        </Card>

        {/* 工单信息 */}
        <aside className="xl:sticky xl:top-4">
          <Card>
            <div className="border-b border-line px-4 py-3 text-[13px] font-semibold text-fg">{t('ticket.info')}</div>
            <dl className="space-y-2.5 px-4 py-3.5">
              <InfoRow label={t('ticket.status')}>
                {admin ? (
                  <Select
                    value={ticket.status}
                    onChange={(value) => {
                      if (value === 'CLOSED') void toggleClosed();
                      else change.mutate({ status: value });
                    }}
                    options={TICKET_STATUSES.map((value) => ({ value, label: t(`ticket.status.${value}`) }))}
                    disabled={busy}
                    aria-label={t('ticket.status')}
                    className="w-32"
                  />
                ) : (
                  <TicketStatusBadge value={ticket.status} />
                )}
              </InfoRow>
              <InfoRow label={t('ticket.priority')}>
                {admin ? (
                  <Select value={ticket.priority} onChange={(value) => change.mutate({ priority: value })} options={priorityOptions(t)} disabled={busy} aria-label={t('ticket.priority')} className="w-32" />
                ) : (
                  <PriorityBadge value={ticket.priority} />
                )}
              </InfoRow>
              <InfoRow label={t('ticket.category')}>
                {admin ? (
                  <Select value={ticket.category} onChange={(value) => change.mutate({ category: value })} options={categoryOptions(t)} disabled={busy} aria-label={t('ticket.category')} className="w-40" />
                ) : (
                  t(`ticket.category.${ticket.category}`)
                )}
              </InfoRow>
              {admin && (
                <InfoRow label={t('ticket.user')}>
                  <span className="block truncate">{ticket.user.name || ticket.user.username}</span>
                  {ticket.user.email && <span className="block truncate text-xs text-fg-3">{ticket.user.email}</span>}
                </InfoRow>
              )}
              {ticket.resourceRef && (
                <InfoRow label={t('ticket.resource')}>
                  <Link to={`${admin ? '/admin' : '/console'}/instances/${ticket.resourceRef}`} className="break-all underline-offset-2 hover:underline">
                    {ticket.resourceName || `#${ticket.resourceRef}`}
                  </Link>
                </InfoRow>
              )}
              <InfoRow label={t('ticket.messageCount')}>
                <span className="tabular">{ticket.counts.messages}</span>
              </InfoRow>
              <InfoRow label={t('ticket.createdAt')}>
                <span className="tabular text-xs">{formatDate(ticket.createdAt)}</span>
              </InfoRow>
              <InfoRow label={t('ticket.updatedAt')}>
                <span className="tabular text-xs">{formatDate(ticket.lastReplyAt)}</span>
              </InfoRow>
              {ticket.closedAt && (
                <InfoRow label={t('ticket.closedAt')}>
                  <span className="tabular text-xs">{formatDate(ticket.closedAt)}</span>
                </InfoRow>
              )}
            </dl>
            {admin && (
              <div className="border-t border-line px-3 py-2.5">
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={<Trash2 />}
                  className="w-full"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirm({ title: t('ticket.deleteTitle', { number: ticket.number }), description: t('ticket.deleteDesc'), danger: true, confirmText: t('ticket.delete') })) remove.mutate();
                  }}
                >
                  {t('ticket.delete')}
                </Button>
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
