import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import type { TaskDTO } from '../../shared/index';
import { TaskStatusBadge } from '@/components/status';
import { Card, CardHeader, Empty, ErrorState } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useInstanceApiPath, isBusy, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { dayjs, formatDate, formatDuration } from '@/lib/format';

function duration(task: TaskDTO): string {
  if (!task.startedAt || !task.finishedAt) return '—';
  return formatDuration(dayjs(task.finishedAt).diff(dayjs(task.startedAt), 'second'));
}

export default function Tasks({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t, L } = useI18n();
  const q = useQuery({
    queryKey: ['instance-tasks', inst.id],
    queryFn: () => api.get<TaskDTO[]>(`${instancePath}/tasks`),
    refetchInterval: isBusy(inst) ? 2000 : false,
  });
  return (
    <Card>
      <CardHeader title={t('detail.tab.tasks')} icon={<ListChecks />} description={t('tasks.recent50')} />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(task) => task.id}
          empty={<Empty title={t('dash.noRecent')} />}
          columns={[
            { key: 'type', header: t('tasks.action'), cell: (task) => <span className="font-medium">{L.taskType[task.type]}</span> },
            { key: 'status', header: t('common.status'), cell: (task) => <TaskStatusBadge status={task.status} /> },
            { key: 'user', header: t('common.operator'), cell: (task) => <span className="text-fg-2">{task.user?.username ?? t('common.system')}</span> },
            { key: 'time', header: t('tasks.submittedAt'), cell: (task) => <span className="tabular text-xs">{formatDate(task.createdAt, 'YYYY-MM-DD HH:mm:ss')}</span> },
            { key: 'dur', header: t('tasks.duration'), cell: (task) => <span className="text-xs text-fg-2">{duration(task)}</span> },
            {
              key: 'error',
              header: t('common.description'),
              mobile: 'full',
              cell: (task) => (task.error ? <span className="block max-w-sm text-xs break-words text-danger-text">{task.error}</span> : <span className="text-fg-3">—</span>),
            },
          ]}
        />
      )}
    </Card>
  );
}
