import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Paginated, TaskDTO } from '../shared/index';
import { TaskStatusBadge } from '@/components/status';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fromNow } from '@/lib/format';

/** 进行中（排队 + 执行中）的任务数量 */
async function activeCount() {
  const [running, queued] = await Promise.all([
    api.get<Paginated<TaskDTO>>('/admin/tasks', { status: 'RUNNING', page: 1, pageSize: 1 }),
    api.get<Paginated<TaskDTO>>('/admin/tasks', { status: 'QUEUED', page: 1, pageSize: 1 }),
  ]);
  return running.total + queued.total;
}

/** 顶栏任务：和通知一样的小弹窗，列出最近的任务；有进行中的任务时图标上显示数量 */
export function TasksPopover() {
  const { t, L } = useI18n();
  const [open, setOpen] = useState(false);
  const active = useQuery({ queryKey: ['admin-tasks-active'], queryFn: activeCount, refetchInterval: 15_000 });
  const recent = useQuery({
    queryKey: ['admin-tasks-recent'],
    queryFn: () => api.get<Paginated<TaskDTO>>('/admin/tasks', { page: 1, pageSize: 8 }),
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });
  const n = active.data ?? 0;
  const items = recent.data?.items ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={t('nav.admin.tasks')}
        title={t('nav.admin.tasks')}
        className="relative flex size-8 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg data-popup-open:bg-surface-3 [&>svg]:size-[17px]"
      >
        <ListChecks />
        {n > 0 && (
          <span className="tabular absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-medium text-primary-fg ring-2 ring-bg">
            {n > 99 ? '99+' : n}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[70]">
          <Popover.Popup className="popup-anim w-[min(32rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-card outline-none">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
              <Popover.Title className="text-[13px] font-semibold">{t('nav.admin.tasks')}</Popover.Title>
              <span className="text-xs text-fg-4">{n > 0 ? t('shell.tasksActive', { n }) : t('shell.tasksIdle')}</span>
            </div>
            <div className="scrollbar-thin max-h-[16rem] overflow-y-auto">
              {recent.isLoading ? (
                <div className="px-4 py-6 text-center text-[13px] text-fg-3">{t('common.loading')}</div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                  <ListChecks className="size-7 stroke-1 text-fg-4" />
                  <p className="text-[13px] text-fg-3">{t('shell.noTasks')}</p>
                </div>
              ) : (
                <ul className="divide-y divide-line/70">
                  {items.map((task) => (
                    // 每个任务一行：类型、实例、时间、状态；失败原因悬停查看
                    <li key={task.id} className="flex items-center gap-3 px-3.5 py-1.5" title={task.error ?? undefined}>
                      <span className="w-24 shrink-0 truncate text-[13px] font-medium text-fg">{L.taskType[task.type]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">
                        {task.instanceName ?? (task.instanceId ? `#${task.instanceId}` : '—')}
                        {task.error && <span className="ml-2 font-sans text-danger-text">{task.error}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-fg-4">{fromNow(task.createdAt)}</span>
                      <TaskStatusBadge status={task.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Link
              to="/admin/tasks?tab=tasks"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-1 border-t border-line py-2 text-[13px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
            >
              {t('shell.allTasks')}
              <ChevronRight className="size-3.5" />
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
