import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, Clock3, LifeBuoy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { DocumentDTO, PublicDocumentsDTO } from '../../shared/index';
import { Markdown, parseMarkdown } from '@/components/Markdown';
import { PageHeader } from '@/components/page';
import { buttonClass } from '@/components/ui/button';
import { ErrorState, PageLoading } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { usePublicConfig } from '@/lib/queries';

export default function DocumentDetail() {
  const t = useT();
  const { slug } = useParams();
  const { search } = useLocation();
  const { data: site } = usePublicConfig();
  const q = useQuery({ queryKey: ['public-document', slug], queryFn: () => api.get<DocumentDTO>(`/public/documents/${encodeURIComponent(slug ?? '')}`) });
  const index = useQuery({ queryKey: ['public-documents'], queryFn: () => api.get<PublicDocumentsDTO>('/public/documents') });
  const contentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const toc = useMemo(() => q.data ? parseMarkdown(q.data.content).headings.filter(h => h.level <= 2) : [], [q.data]);
  const back = `/console/documents${search}`;
  const title = q.data?.title ?? t('documents.publicCenter');

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} - ${site?.siteName ?? 'PaleDove'}`;
    return () => { document.title = previous; };
  }, [title, site?.siteName]);

  // 桌面控制台在内容面板内滚动，手机端则滚动窗口，两者都要更新章节高亮。
  useEffect(() => {
    const panel = contentRef.current?.closest('main')?.parentElement;
    const onScroll = () => {
      const inPanel = panel && getComputedStyle(panel).overflowY === 'auto';
      const top = inPanel ? panel.getBoundingClientRect().top : 0;
      const header = Number.parseFloat(getComputedStyle(contentRef.current!).getPropertyValue('--header-h')) || 56;
      let current: string | null = toc[0]?.id ?? null;
      for (const heading of toc) if ((document.getElementById(heading.id)?.getBoundingClientRect().top ?? Infinity) < top + header + 40) current = heading.id;
      const scrollTop = inPanel ? panel.scrollTop : window.scrollY;
      const max = inPanel ? panel.scrollHeight - panel.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0 && scrollTop >= max - 4) current = toc.at(-1)?.id ?? null;
      setActive(current);
    };
    onScroll();
    panel?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      panel?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [toc]);

  const tocList = <ol className="space-y-1" translate="no">{toc.map((heading, i) => <li key={heading.id}>
    <a href={`#${heading.id}`} aria-current={active === heading.id ? 'location' : undefined} onClick={event => {
      event.preventDefault();
      // 先收起手机目录，避免滚动结束后折叠目录又把目标章节推离可视区域。
      setTocOpen(false);
      requestAnimationFrame(() => document.getElementById(heading.id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
    }} className={cn('flex gap-2.5 rounded-md px-2.5 py-2 text-[13px] leading-5 transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none', active === heading.id ? 'bg-surface-3 font-medium text-fg' : 'text-fg-3 hover:bg-surface-2 hover:text-fg')}>
      <span className="tabular shrink-0 text-xs text-fg-4">{String(i + 1).padStart(2, '0')}</span><span className="min-w-0 break-words">{heading.text}</span>
    </a>
  </li>)}</ol>;

  return <div ref={contentRef}>
    <PageHeader title={title} back={{ to: back, label: t('documents.backToCenter') }} description={q.data && <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {index.data?.categories.find(category => category.id === q.data.categoryId)?.name && <span className="rounded-md bg-surface-3 px-2 py-1" translate="no">{index.data.categories.find(category => category.id === q.data.categoryId)?.name}</span>}
      {q.data.updatedAt && <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" aria-hidden />{t('legal.updated', { time: formatDate(q.data.updatedAt, 'YYYY-MM-DD') })}</span>}
    </span>} />
    {q.data ? <div className={cn('grid items-start gap-5', toc.length > 0 && 'xl:grid-cols-[minmax(0,1fr)_220px]')}>
      <div className="min-w-0">
        {toc.length > 0 && <nav className="mb-4 overflow-hidden rounded-xl border border-line bg-surface xl:hidden" aria-label={t('legal.onThisPage')}>
          <button type="button" aria-expanded={tocOpen} aria-controls="document-toc" onClick={() => setTocOpen(value => !value)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-[13px] font-medium text-fg"><span className="flex items-center gap-2"><BookOpen className="size-4 text-fg-3" aria-hidden />{t('legal.onThisPage')}</span><ChevronDown className={cn('size-4 text-fg-3 transition-transform', tocOpen && 'rotate-180')} aria-hidden /></button>
          {tocOpen && <div id="document-toc" className="max-h-72 overflow-y-auto border-t border-line p-2">{tocList}</div>}
        </nav>}
        <article className="rounded-xl border border-line bg-surface p-5 sm:p-7" translate="no">
          <Markdown source={q.data.content} className="break-words [&_h1]:scroll-mt-[calc(var(--header-h)+1.5rem)] [&_h2]:scroll-mt-[calc(var(--header-h)+1.5rem)] [&_h3]:scroll-mt-[calc(var(--header-h)+1.5rem)] [&_h4]:scroll-mt-[calc(var(--header-h)+1.5rem)]" />
        </article>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/60 p-4 sm:px-5">
          <div className="flex items-center gap-3"><LifeBuoy className="size-5 shrink-0 text-fg-3" aria-hidden /><p className="text-[13px] text-fg-2">{t('documents.questions')}</p></div>
          <Link to="/console/tickets/new" className={buttonClass('secondary', 'sm')}>{t('legal.contact')}</Link>
        </div>
      </div>
      {toc.length > 0 && <aside className="sticky top-[calc(var(--header-h)+1.5rem)] hidden min-w-0 rounded-xl border border-line bg-surface-2/50 p-3 xl:block">
        <h2 className="flex items-center gap-2 px-2.5 pt-1 pb-3 text-xs font-medium text-fg-3"><BookOpen className="size-3.5" aria-hidden />{t('legal.onThisPage')}</h2>
        <nav className="max-h-[calc(100dvh-var(--header-h)-10rem)] overflow-y-auto" aria-label={t('legal.onThisPage')}>{tocList}</nav>
      </aside>}
    </div> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading />}
  </div>;
}
