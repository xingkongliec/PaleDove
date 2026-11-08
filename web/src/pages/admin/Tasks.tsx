import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LOG_MODULES, TASK_STATUSES, TASK_TYPES, type ActivityLogDTO, type LogModule, type Paginated, type TaskDTO, type TaskStatus, type TaskType } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { TaskStatusBadge } from '@/components/status';
import { ExpandText, FilterCard, LogDetail, logFailed, logModuleOf, TABLE_SCROLL, taskDuration } from '@/components/log-table';
import { FormField } from '@/components/ui/input';
import { Badge, Card, Empty, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n, useT } from '@/i18n';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

/** 任务队列：按状态、类型筛选，搜索实例、操作者或错误信息 */
function TaskList() {
  const { t, L } = useI18n();
  const [status, setStatus] = useState<TaskStatus | 'ALL'>('ALL');
  const [type, setType] = useState<TaskType | 'ALL'>('ALL');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const list = useQuery({
    queryKey: ['admin-tasks', status, type, q, page, pageSize],
    queryFn: () =>
      api.get<Paginated<TaskDTO>>('/admin/tasks', { status: status === 'ALL' ? undefined : status, type: type === 'ALL' ? undefined : type, q: q || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });
  return (
    <div className="space-y-4">
      <FilterCard
        input={input}
        onInput={setInput}
        placeholder={t('adminTasks.searchPlaceholder')}
        onSearch={() => {
          setQ(input.trim());
          setPage(1);
        }}
        onReset={() => {
          setStatus('ALL');
          setType('ALL');
          setInput('');
          setQ('');
          setPage(1);
        }}
      >
        <FormField label={t('common.status')} className="min-w-0 md:flex-1">
          <Select<TaskStatus | 'ALL'>
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: 'ALL', label: t('adminTasks.allStatus'), description: t('adminTasks.allStatusDesc') },
              ...TASK_STATUSES.map((s) => ({ value: s, label: L.taskStatus[s], description: t(`adminTasks.statusDesc.${s}`) })),
            ]}
          />
        </FormField>
        <FormField label={t('adminTasks.type')} className="min-w-0 md:flex-1">
          <Select<TaskType | 'ALL'>
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={[{ value: 'ALL', label: t('adminTasks.allTypes'), description: t('adminTasks.allTypesDesc') }, ...TASK_TYPES.map((x) => ({ value: x, label: L.taskType[x] }))]}
          />
        </FormField>
      </FilterCard>
      <Card className="overflow-hidden">
        <DataTable
          scrollClassName={TABLE_SCROLL}
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(task) => task.id}
          empty={<Empty title={t('adminTasks.empty')} />}
          columns={[
            { key: 'time', header: t('common.time'), cell: (task) => <span className="tabular text-[13px] whitespace-nowrap text-fg-2">{formatDate(task.createdAt, 'YYYY/MM/DD HH:mm:ss')}</span> },
            {
              key: 'type',
              header: t('adminTasks.task'),
              mobile: 'title',
              cell: (task) => (
                <span className="font-medium whitespace-nowrap text-fg">
                  {L.taskType[task.type]} <span className="tabular text-xs font-normal text-fg-4">#{task.id}</span>
                </span>
              ),
            },
            {
              key: 'inst',
              header: t('common.instance'),
              cell: (task) =>
                task.instanceId ? (
                  <Link className="font-mono text-xs font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg" to={`/admin/instances/${task.instanceId}`}>
                    {task.instanceName ?? `#${task.instanceId}`}
                  </Link>
                ) : (
                  <span className="text-fg-4">—</span>
                ),
            },
            { key: 'user', header: t('common.operator'), cell: (task) => <span className="text-fg-2">{task.user?.username ?? t('common.system')}</span> },
            { key: 'status', header: t('common.status'), cell: (task) => <TaskStatusBadge status={task.status} /> },
            { key: 'duration', header: t('adminTasks.duration'), cell: (task) => <span className="tabular text-xs whitespace-nowrap text-fg-3">{taskDuration(task, t) ?? '—'}</span> },
            { key: 'error', header: t('adminTasks.error'), mobile: 'full', cell: (task) => <ExpandText text={task.error} className="text-danger-text" /> },
          ]}
        />
        {list.data && (
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

/** 操作日志：按模块筛选，搜索用户名、操作或内容 */
function ActivityList() {
  const t = useT();
  const [module, setModule] = useState<LogModule | 'all'>('all');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const list = useQuery({
    queryKey: ['admin-logs', module, q, page, pageSize],
    queryFn: () => api.get<Paginated<ActivityLogDTO>>('/admin/logs', { module: module === 'all' ? undefined : module, q: q || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  const search = () => {
    setQ(input.trim());
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <FilterCard
        input={input}
        onInput={setInput}
        placeholder={t('logs.searchPlaceholder')}
        onSearch={search}
        onReset={() => {
          setModule('all');
          setInput('');
          setQ('');
          setPage(1);
        }}
      >
        <FormField label={t('logs.module')} className="min-w-0 md:flex-[2]">
          <Select<LogModule | 'all'>
            value={module}
            onChange={(v) => {
              setModule(v);
              setPage(1);
            }}
            options={[
              { value: 'all', label: t('logs.allModules'), description: t('logs.allModulesDesc') },
              ...LOG_MODULES.map((m) => ({ value: m, label: t(`logs.module.${m}`), description: t(`logs.moduleDesc.${m}`) })),
            ]}
          />
        </FormField>
      </FilterCard>
      <Card className="overflow-hidden">
        <DataTable
          scrollClassName={TABLE_SCROLL}
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(a) => a.id}
          empty={<Empty title={t('adminTasks.noLogs')} />}
          columns={[
            { key: 'time', header: t('common.time'), cell: (a) => <span className="tabular text-[13px] whitespace-nowrap text-fg-2">{formatDate(a.createdAt, 'YYYY/MM/DD HH:mm:ss')}</span> },
            { key: 'user', header: t('common.user'), mobile: 'title', cell: (a) => <span className="font-medium text-fg">{a.user?.username ?? '—'}</span> },
            {
              key: 'module',
              header: t('logs.module'),
              cell: (a) => {
                const m = logModuleOf(a.action) as LogModule;
                return <Tag>{(LOG_MODULES as readonly string[]).includes(m) ? t(`logs.module.${m}`) : m}</Tag>;
              },
            },
            { key: 'action', header: t('adminTasks.action'), cell: (a) => <span className="font-mono text-xs text-fg">{a.action.slice(a.action.indexOf('.') + 1)}</span> },
            { key: 'detail', header: t('logs.content'), mobile: 'full', cell: (a) => <LogDetail log={a} /> },
            {
              key: 'result',
              header: t('logs.result'),
              cell: (a) => <Badge tone={logFailed(a.action) ? 'danger' : 'success'}>{logFailed(a.action) ? t('logs.failed') : t('logs.success')}</Badge>,
            },
          ]}
        />
        {list.data && (
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

export default function AdminTasks() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'tasks' ? 'tasks' : 'logs';
  return (
    <>
      <PageHeader title={t('nav.admin.tasks')} description={t('adminTasks.subtitle')} />
      <TabBar
        value={tab}
        onChange={(value) => setParams(value === 'tasks' ? { tab: 'tasks' } : {}, { replace: true })}
        className="mb-4"
        items={[
          { value: 'logs', label: t('adminTasks.logs') },
          { value: 'tasks', label: t('adminTasks.queue') },
        ]}
      />
      {tab === 'tasks' ? <TaskList /> : <ActivityList />}
    </>
  );
}
