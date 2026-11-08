// 任务与操作日志表格共用的部件：管理后台「任务与队列」与用户「操作日志」页面使用同一套布局
import { ChevronDown, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ActivityLogDTO, TaskDTO } from '../shared/index';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/input';
import { Card } from '@/components/ui/misc';
import { useT, type TFunction } from '@/i18n';
import { cn } from '@/lib/cn';

/** 表格高度：放不下时表格内单独滚动，表头固定；屏幕很矮时至少保留 20rem */
export const TABLE_SCROLL = 'max-h-[max(20rem,calc(100dvh-22rem))]';

/** 长文本：过长时截断，点击箭头展开全文 */
export function ExpandText({ text, className }: { text: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-fg-4">—</span>;
  const long = text.length > 48;
  return (
    <div className="flex max-w-xl items-start gap-1.5">
      <span className={cn('min-w-0 flex-1 text-[13px]', open ? 'break-words whitespace-pre-wrap' : 'truncate', className ?? 'text-fg-2')} title={open ? undefined : text}>
        {text}
      </span>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="shrink-0 rounded p-0.5 text-fg-3 transition-colors hover:text-fg" aria-expanded={open}>
          <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}

/** 筛选卡片：若干筛选项 + 搜索框 + 搜索 / 重置 */
export function FilterCard({
  children,
  input,
  onInput,
  placeholder,
  onSearch,
  onReset,
}: {
  children: ReactNode;
  input: string;
  onInput: (v: string) => void;
  placeholder: string;
  onSearch: () => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <Card className="p-4">
      <form
        className="flex flex-col gap-3 md:flex-row md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
      >
        {children}
        <FormField label={t('common.search')} className="min-w-0 md:flex-[2]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-4" />
            <Input className="pl-8" placeholder={placeholder} value={input} onChange={(e) => onInput(e.target.value)} />
          </div>
        </FormField>
        <div className="flex gap-2">
          <Button type="submit">{t('common.search')}</Button>
          <Button type="button" onClick={onReset}>
            {t('common.reset')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** 任务耗时：执行中按当前时间计算 */
export function taskDuration(task: TaskDTO, t: TFunction) {
  if (!task.startedAt) return null;
  const sec = Math.max(0, Math.round(((task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now()) - new Date(task.startedAt).getTime()) / 1000));
  return sec < 60 ? t('adminTasks.secs', { n: sec }) : t('adminTasks.mins', { m: Math.floor(sec / 60), s: sec % 60 });
}

/** 日志内容：IP 附在末尾 */
export function LogDetail({ log }: { log: ActivityLogDTO }) {
  return <ExpandText text={[log.detail, log.ip ? `[IP: ${log.ip}]` : null].filter(Boolean).join(' ') || null} />;
}

/** 操作名的前缀即模块；名称里带 failed 的是失败记录 */
export const logModuleOf = (action: string) => action.split('.')[0]!;
export const logFailed = (action: string) => action.includes('failed');
