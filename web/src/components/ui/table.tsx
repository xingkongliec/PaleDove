import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { Select } from './select';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  /**
   * 手机卡片视图中的位置：title 标题区、actions 右上角、full 独占一行、hide 隐藏；
   * 默认作为两列字段展示。未指定 title 时首列作为标题，key 为 actions 的列放在右上角。
   */
  mobile?: 'title' | 'actions' | 'full' | 'hide';
}

function mobileRole<T>(c: Column<T>, index: number, columns: Column<T>[]): NonNullable<Column<T>['mobile']> | 'field' {
  if (c.mobile) return c.mobile;
  if (c.key === 'actions') return 'actions';
  if (index === 0 && !columns.some((x) => x.mobile === 'title')) return 'title';
  return 'field';
}

/** 数据表格：桌面端为表格，手机端自动切换为卡片列表 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  onRowClick,
  scrollClassName,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string | number;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** 表格自己滚动时的高度限制（如 max-h-[60vh]）：表头固定在顶部，只滚动表格内容 */
  scrollClassName?: string;
}) {
  if (loading && !rows) return <TableSkeleton cols={Math.min(columns.length, 5)} />;
  if (!rows || rows.length === 0) return <>{empty}</>;
  const roles = columns.map((c, i) => mobileRole(c, i, columns));

  return (
    <>
      <div className={cn('scrollbar-thin hidden overflow-x-auto md:block', scrollClassName && cn('overflow-y-auto overscroll-contain', scrollClassName))}>
        <table className="w-full border-collapse text-[13px]">
          <thead className={cn(scrollClassName && 'sticky top-0 z-[1]')}>
            <tr className={cn('border-b border-line text-left text-xs text-fg-3', scrollClassName ? 'bg-surface-2 shadow-[0_1px_0_var(--border)]' : 'bg-surface-2/70')}>
              {columns.map((c) => (
                <th key={c.key} className={cn('px-4 py-2.5 font-medium whitespace-nowrap first:pl-5 last:pr-5', c.headerClassName)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={rowKey(row)}
                style={{ ['--i' as string]: i }}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('row-in border-b border-line/70 transition-colors duration-150 last:border-0 hover:bg-surface-2/60', onRowClick && 'cursor-pointer')}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-3 align-middle first:pl-5 last:pr-5', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-line/70 md:hidden">
        {rows.map((row, i) => {
          const titles = columns.filter((_, i) => roles[i] === 'title');
          const actions = columns.filter((_, i) => roles[i] === 'actions');
          const fields = columns.filter((_, i) => roles[i] === 'field' || roles[i] === 'full');
          return (
            <li
              key={rowKey(row)}
              style={{ ['--i' as string]: i }}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn('row-in px-4 py-3.5 text-[13px]', onRowClick && 'cursor-pointer active:bg-surface-2')}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  {titles.map((c) => (
                    <div key={c.key}>{c.cell(row)}</div>
                  ))}
                </div>
                {actions.length > 0 && (
                  <div className="-mt-1 -mr-1 flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {actions.map((c) => (
                      <div key={c.key}>{c.cell(row)}</div>
                    ))}
                  </div>
                )}
              </div>
              {fields.length > 0 && (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                  {fields.map((c) => (
                    <div key={c.key} className={cn('min-w-0', (c.mobile === 'full' || !c.header) && 'col-span-2')}>
                      {c.header && <dt className="text-[11px] text-fg-3">{c.header}</dt>}
                      <dd className="mt-0.5 min-w-0 text-[13px] break-words text-fg">{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy>
      <div className="hidden h-9 border-b border-line bg-surface-2/70 md:block" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="fade-in-delay flex items-center gap-6 border-b border-line/70 px-5 py-3.5 last:border-0" style={{ animationDelay: `${160 + r * 50}ms` }}>
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="flex-1">
              <div className="skeleton h-4" style={{ width: `${55 + ((r * 7 + c * 13) % 40)}%`, minWidth: 28 }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 分页；传入 onPageSizeChange 时始终显示，并可切换每页条数 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  onPageSizeChange,
  pageSizes = [20, 50, 100, 500],
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (p: number) => void;
  onPageSizeChange?: (n: number) => void;
  pageSizes?: number[];
}) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && !onPageSizeChange) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-fg-3 sm:px-5">
      {onPageSizeChange ? (
        <span className="tabular flex items-center gap-3">
          <span className="hidden sm:inline">{t('common.pageInfoFull', { total, page, pages })}</span>
          <Select<number>
            aria-label={t('common.perPage', { n: pageSize })}
            value={pageSize}
            onChange={onPageSizeChange}
            options={pageSizes.map((n) => ({ value: n, label: t('common.perPage', { n }) }))}
            className="h-7 w-24 text-xs"
          />
        </span>
      ) : (
        <span className="tabular">{t('common.pageInfo', { total, n: total })}</span>
      )}
      <div className="flex items-center gap-1.5">
        <button
          className="rounded-md p-1.5 transition-colors hover:not-disabled:bg-surface-3 hover:not-disabled:text-fg disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label={t('common.prevPage')}
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="tabular">
          {page} / {pages}
        </span>
        <button
          className="rounded-md p-1.5 transition-colors hover:not-disabled:bg-surface-3 hover:not-disabled:text-fg disabled:opacity-40"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
          aria-label={t('common.nextPage')}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
