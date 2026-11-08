import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, Clock3, FileText, FolderOpen, LifeBuoy, Pin, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PublicDocumentsDTO } from '../../shared/index';
import { PublicFooter, PublicHeader } from '@/components/landing/PublicShell';
import { PageHeader } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, ErrorState, PageLoading } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { usePublicConfig } from '@/lib/queries';
import { prefetchRoute } from '@/lib/routes';

export default function DocumentsPage({ consoleView = false }: { consoleView?: boolean }) {
  const t = useT();
  const { data: site } = usePublicConfig();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const category = params.get('category') ?? 'all';
  const q = useQuery({ queryKey: ['public-documents'], queryFn: () => api.get<PublicDocumentsDTO>('/public/documents') });
  const title = t('documents.publicCenter');
  useEffect(() => { const previous = document.title; document.title = `${title} - ${site?.siteName ?? 'PaleDove'}`; return () => { document.title = previous; }; }, [title, site?.siteName]);
  const documents = q.data?.documents ?? [];
  const categories = q.data?.categories ?? [];
  const rows = documents.filter(doc => (category === 'all' || doc.categoryId === category) && `${doc.title} ${doc.slug}`.toLowerCase().includes(search.trim().toLowerCase()));
  const filtered = !!search || category !== 'all';
  const setFilter = (key: string, value: string) => setParams(current => {
    const next = new URLSearchParams(current);
    if (!value || (key === 'category' && value === 'all')) next.delete(key);
    else next.set(key, value);
    return next;
  }, { replace: true });
  const clearFilters = () => { setSearch(''); setParams({}, { replace: true }); };
  const content = <>
    <PageHeader title={title} description={t('documents.publicSubtitle')} actions={consoleView && <Link to="/tickets/new" className={buttonClass('secondary', 'md')}><LifeBuoy />{t('legal.contact')}</Link>} />
    <section className="mb-5 rounded-xl border border-line bg-linear-to-br from-surface-2 to-surface p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 sm:flex"><BookOpen className="size-5" aria-hidden /></span>
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-4" />
          <Input type="search" className="h-10 pl-9" aria-label={t('documents.search')} placeholder={t('documents.search')} value={search} onChange={event => { setSearch(event.target.value); setFilter('q', event.target.value); }} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label={t('documents.category')}>
        {[{ id: 'all', name: t('documents.allCategories') }, ...categories].map(cat => {
          const count = cat.id === 'all' ? documents.length : documents.filter(doc => doc.categoryId === cat.id).length;
          return <button key={cat.id} type="button" aria-pressed={category === cat.id} onClick={() => setFilter('category', cat.id)} className={cn('inline-flex min-h-8 items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none', category === cat.id ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface text-fg-2 hover:border-line-strong hover:bg-surface-3')}>
            {cat.name}<span className="tabular opacity-60">{q.data ? count : '—'}</span>
          </button>;
        })}
      </div>
    </section>
    {!q.data ? q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading /> : <section aria-label={t('documents.list')}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg"><FolderOpen className="size-4 shrink-0 text-fg-3" aria-hidden /><span className="break-words">{categories.find(cat => cat.id === category)?.name ?? t('documents.allCategories')}</span><span className="shrink-0 text-xs font-normal text-fg-3" role="status">{t('documents.count', { n: rows.length })}</span></h2>
        {filtered && <Button size="sm" variant="ghost" icon={<X />} onClick={clearFilters}>{t('documents.clearFilters')}</Button>}
      </div>
      {rows.length ? <div className="grid gap-3 md:grid-cols-2 xl:gap-4">{rows.map(doc => {
        const to = consoleView ? `/console/documents/${doc.slug}${params.size ? `?${params}` : ''}` : doc.kind ? `/${doc.kind}` : `/help/${doc.slug}`;
        const Icon = doc.kind === 'privacy' ? ShieldCheck : FileText;
        return <Link key={doc.id} to={to} onMouseEnter={() => prefetchRoute(to)} onFocus={() => prefetchRoute(to)} className="group flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 outline-none transition-[border-color,box-shadow,background-color] hover:border-line-strong hover:bg-surface-2/50 hover:shadow-xs focus-visible:ring-3 focus-visible:ring-ring sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2 transition-colors group-hover:bg-surface-3"><Icon className="size-5" aria-hidden /></span>
            <div className="flex min-w-0 flex-wrap justify-end gap-2 text-xs text-fg-3"><span className="rounded-md bg-surface-3 px-2 py-1 break-words" translate="no">{categories.find(cat => cat.id === doc.categoryId)?.name}</span>{doc.pinned && <span className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1"><Pin className="size-3" aria-hidden />{t('dash.pinned')}</span>}</div>
          </div>
          <h3 className="text-base leading-6 font-semibold break-words text-fg" translate="no">{doc.title}</h3>
          {doc.kind && <p className="mt-1.5 text-[13px] leading-6 text-fg-3">{t(doc.kind === 'privacy' ? 'documents.privacyDescription' : 'documents.termsDescription')}</p>}
          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-5">
            <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">{doc.updatedAt ? <><Clock3 className="size-3.5 shrink-0" aria-hidden /><time dateTime={doc.updatedAt}>{formatDate(doc.updatedAt, 'YYYY-MM-DD')}</time></> : doc.kind ? t('documents.builtin') : null}</span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-fg-2 group-hover:text-fg">{t('documents.read')}<ArrowRight className="size-3.5 transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden /></span>
          </div>
        </Link>;
      })}</div> : <div className="rounded-xl border border-dashed border-line bg-surface-2/40"><Empty icon={<Search />} title={t('documents.empty')} description={t('documents.emptyHint')} action={filtered && <Button size="sm" onClick={clearFilters}>{t('documents.clearFilters')}</Button>} /></div>}
    </section>}
  </>;
  if (consoleView) return content;
  return <div className="flex min-h-dvh flex-col overflow-x-clip bg-bg">
    <PublicHeader active="help" />
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-28 pb-12 sm:px-6">
      {content}
    </main>
    <PublicFooter />
  </div>;
}
