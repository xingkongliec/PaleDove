import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { LOG_MODULES, TASK_STATUSES, TASK_TYPES, type ActivityLogDTO, type LogModule, type Paginated, type TaskDTO, type TaskStatus, type TaskType } from '../../shared/index';
import { ExpandText, FilterCard, LogDetail, logFailed, logModuleOf, TABLE_SCROLL, taskDuration } from '@/components/log-table';
import { PageHeader } from '@/components/page';
import { TaskStatusBadge } from '@/components/status';
import { FormField } from '@/components/ui/input';
import { Badge, Card, Empty, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n, useT } from '@/i18n';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

/** 普通用户的日志里只会出现这些模块 */
const USER_MODULES = LOG_MODULES.filter((m) => m !== 'admin' && m !== 'agent');

/** 任务记录：当前账户所有实例的操作任务，按状态、类型筛选，搜索实例或错误信息 */
function TaskList() {
  const { t, L } = useI18n();
  const [status, setStatus] = useState<TaskStatus | 'ALL'>('ALL');
  const [type, setType] = useState<TaskType | 'ALL'>('ALL');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const list = useQuery({
    queryKey: ['all-tasks', status, type, q, page, pageSize],
    queryFn: () => api.get<Paginated<TaskDTO>>('/tasks', { status: status === 'ALL' ? undefined : status, type: type === 'ALL' ? undefined : type, q: q || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((x) => x.status === 'QUEUED' || x.status === 'RUNNING') ? 3000 : false),
  });
  return (
    <div className="space-y-4">
      <FilterCard
        input={input}
        onInput={setInput}
        placeholder={t('activity.searchTasks')}
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
          empty={<Empty title={t('activity.empty')} />}
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
                  <Link className="font-mono text-xs font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg" to={`/console/instances/${task.instanceId}`}>
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

/** 账号操作日志：登录、账号设置、实例、费用等操作，按模块筛选，搜索操作、内容或 IP */
function ActivityList() {
  const t = useT();
  const [module, setModule] = useState<LogModule | 'all'>('all');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const list = useQuery({
    queryKey: ['my-logs', module, q, page, pageSize],
    queryFn: () => api.get<Paginated<ActivityLogDTO>>('/logs', { module: module === 'all' ? undefined : module, q: q || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-4">
      <FilterCard
        input={input}
        onInput={setInput}
        placeholder={t('activity.searchLogs')}
        onSearch={() => {
          setQ(input.trim());
          setPage(1);
        }}
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
              ...USER_MODULES.map((m) => ({ value: m, label: t(`logs.module.${m}`), description: t(`logs.moduleDesc.${m}`) })),
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
            {
              key: 'module',
              header: t('logs.module'),
              cell: (a) => {
                const m = logModuleOf(a.action);
                return <Tag>{(LOG_MODULES as readonly string[]).includes(m) ? t(`logs.module.${m as LogModule}`) : m}</Tag>;
              },
            },
            { key: 'action', header: t('adminTasks.action'), mobile: 'title', cell: (a) => <span className="font-mono text-xs text-fg">{a.action.slice(a.action.indexOf('.') + 1)}</span> },
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

/** 操作日志：任务记录与账号操作日志两个标签，布局与管理后台「任务与队列」一致 */
export default function ActivityPage() {
  const t = useT();
  const [tab, setTab] = useState<'tasks' | 'logs'>('logs');
  return (
    <>
      <PageHeader title={t('nav.activity')} description={t('activity.desc')} />
      <TabBar
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          { value: 'logs', label: t('activity.tabLogs') },
          { value: 'tasks', label: t('activity.tabTasks') },
        ]}
      />
      {tab === 'tasks' ? <TaskList /> : <ActivityList />}
    </>
  );
}
