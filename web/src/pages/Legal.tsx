// 服务条款 / 隐私政策：与首页同一风格。居中的首屏（标签、渐变标题、胶囊切换、更新时间与阅读时长），
// 正文为阅读栏，宽屏右侧吸顶「本页内容」（编号、阅读进度），窄屏折叠目录；底部为「还有疑问」卡片
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronDown, FileText, LifeBuoy, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { DocumentDTO, LegalKind, PublicLegalDTO } from '../shared/index';
import { PublicFooter, PublicHeader } from '@/components/landing/PublicShell';
import { Markdown, parseMarkdown } from '@/components/Markdown';
import { buttonClass } from '@/components/ui/button';
import { ErrorState, PageLoading } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { useMe, usePublicConfig } from '@/lib/queries';

const KINDS: LegalKind[] = ['terms', 'privacy'];
const ICONS = { terms: <FileText />, privacy: <ShieldCheck /> } as const;

/** 平滑滚动到章节，并更新地址栏的锚点 */
function jumpTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  history.replaceState(null, '', `#${id}`);
}

/** 阅读时长（分钟）：中文按每分钟 400 字，英文按每分钟 200 词 */
function readMinutes(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const words = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 200));
}

export default function LegalPage({ kind }: { kind?: LegalKind }) {
  const { t, locale } = useI18n();
  const { data: site } = usePublicConfig();
  const { data: me } = useMe();
  const { slug } = useParams();
  const q = useQuery<Pick<PublicLegalDTO, 'title' | 'content' | 'updatedAt'> & { custom?: boolean }>({
    queryKey: kind ? ['legal', kind] : ['public-document', slug],
    queryFn: () => kind ? api.get<PublicLegalDTO>(`/public/legal/${kind}`) : api.get<DocumentDTO>(`/public/documents/${encodeURIComponent(slug ?? '')}`),
  });
  const toc = useMemo(() => (q.data ? parseMarkdown(q.data.content).headings.filter((h) => h.level <= 2) : []), [q.data]);
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const siteName = site?.siteName ?? 'PaleDove';
  const title = q.data?.title ?? (kind ? t(`legal.${kind}`) : t('documents.publicCenter'));

  useEffect(() => {
    window.scrollTo(0, 0);
    const previous = document.title;
    document.title = `${title} - ${siteName}`;
    return () => {
      document.title = previous;
    };
  }, [title, siteName]);

  useEffect(() => { window.scrollTo(0, 0); setTocOpen(false); }, [kind, slug]);

  // 当前章节（滚动经过的最后一个标题）与阅读进度
  useEffect(() => {
    const onScroll = () => {
      let id: string | null = toc[0]?.id ?? null;
      for (const h of toc) if ((document.getElementById(h.id)?.getBoundingClientRect().top ?? Infinity) < 140) id = h.id;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0 && window.scrollY >= max - 4) id = toc.at(-1)?.id ?? null;
      setActive(id);
      setProgress(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [toc]);

  const tocList = (onPick?: () => void) => (
    <ol className="space-y-0.5" translate="no">
      {toc.map((h, i) => (
        <li key={h.id}>
          <a
            href={`#${h.id}`}
            onClick={(e) => {
              e.preventDefault();
              jumpTo(h.id);
              onPick?.();
            }}
            className={cn(
              'flex gap-2.5 rounded-md px-2 py-1.5 text-[13px] leading-5 transition-colors',
              active === h.id ? 'bg-surface-3 font-medium text-fg' : 'text-fg-3 hover:bg-surface-2 hover:text-fg',
            )}
          >
            <span className="tabular w-5 shrink-0 text-fg-4">{String(i + 1).padStart(2, '0')}</span>
            <span className="min-w-0">{h.text}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip bg-bg">
      <PublicHeader active="legal" />

      {/* ───────── 首屏：居中标题、切换文档、更新时间与阅读时长 ───────── */}
      <section className={cn('border-b border-line px-4 text-center sm:px-6', kind ? 'pt-36 pb-14 sm:pt-40 sm:pb-16' : 'pt-28 pb-8')}>
        <div className="mx-auto max-w-3xl">
          <span className="page-enter inline-flex items-center gap-2.5 rounded-full border border-line bg-surface/70 py-1.5 pr-3.5 pl-3 text-[13px] text-fg-2 backdrop-blur">
            <span className="size-2 rounded-full bg-success" />
            {kind ? t('legal.badge', { name: siteName }) : t('documents.publicCenter')}
          </span>
          <h1 className={cn('page-enter leading-[1.08] font-medium tracking-tight break-words text-fg [animation-delay:80ms]', kind ? 'mt-6 text-[40px] sm:text-[56px]' : 'mt-4 text-3xl sm:text-[40px]')}>
            <span className="text-gradient" translate={kind ? undefined : 'no'}>{title}</span>
          </h1>
          {kind && <p className="page-enter mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-fg-3 [animation-delay:140ms] sm:text-base">{t(`legal.intro.${kind}`)}</p>}
          {/* 胶囊切换 */}
          {kind ? <div className="page-enter mt-8 inline-flex rounded-full border border-line bg-surface p-1 [animation-delay:200ms]" role="tablist">
            {KINDS.map((k) => (
              <Link
                key={k}
                to={`/${k}`}
                role="tab"
                aria-selected={kind === k}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13px] transition-colors [&>svg]:size-4',
                  kind === k ? 'bg-primary font-medium text-primary-fg shadow-xs' : 'text-fg-2 hover:text-fg',
                )}
              >
                {ICONS[k]}
                {t(`legal.${k}`)}
              </Link>
            ))}
          </div> : <Link to="/help" className={buttonClass('secondary', 'sm', 'mt-4')}><ArrowLeft />{t('documents.backToCenter')}</Link>}
          {q.data && (
            <p className="page-enter mt-5 text-[13px] text-fg-3 [animation-delay:240ms]">
              {[q.data.updatedAt ? t('legal.updated', { time: formatDate(q.data.updatedAt, 'YYYY-MM-DD') }) : null, t('legal.readTime', { n: readMinutes(q.data.content) })]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      </section>

      {/* ───────── 正文：阅读栏 + 右侧本页内容 ───────── */}
      <main className={cn('flex-1 px-4 sm:px-6', kind ? 'py-12 sm:py-16' : 'py-8 sm:py-10')}>
        <div className="mx-auto max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_250px] lg:gap-16">
          <article className="mx-auto min-w-0 max-w-3xl lg:mx-0">
            {/* 窄屏：可折叠的目录 */}
            {toc.length > 0 && (
              <div className="mb-8 rounded-xl border border-line bg-surface lg:hidden">
                <button type="button" onClick={() => setTocOpen(!tocOpen)} className="flex w-full items-center justify-between px-4 py-3 text-[13px] font-medium text-fg">
                  {t('legal.onThisPage')}
                  <ChevronDown className={cn('size-4 text-fg-3 transition-transform', tocOpen && 'rotate-180')} />
                </button>
                {tocOpen && <div className="border-t border-line p-2">{tocList(() => setTocOpen(false))}</div>}
              </div>
            )}
            {kind && locale === 'en' && q.data && !q.data.custom && <p className="mb-8 rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-fg-3">{t('legal.chineseOnly')}</p>}
            {q.data ? (
              // 顶部是悬浮导航：跳转到章节时标题留出导航的高度
              <div translate="no" className="[&_h1]:scroll-mt-28 [&_h2]:scroll-mt-28 [&_h3]:scroll-mt-28">
                <Markdown source={q.data.content} />
              </div>
            ) : q.error ? (
              <ErrorState error={q.error} onRetry={() => void q.refetch()} />
            ) : (
              <PageLoading />
            )}

            {/* 还有疑问：首页卡片样式 */}
            <div className="mt-14 flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 sm:flex-row sm:items-center sm:p-6">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2">
                <LifeBuoy className="size-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-medium text-fg">{t(kind ? 'legal.questions' : 'documents.questions')}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-fg-3">{t('legal.questionsDesc')}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Link to={me ? (me.role === 'ADMIN' ? '/admin/tickets' : '/tickets/new') : '/login?redirect=%2Ftickets%2Fnew'} className={buttonClass('primary', 'md', 'group')}>
                  {t('legal.contact')}
                  <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link to="/" className={buttonClass('secondary', 'md')}>
                  {t('legal.home')}
                </Link>
              </div>
            </div>
          </article>

          {/* 宽屏：本页内容（吸顶，带阅读进度） */}
          <aside className="hidden lg:block">
            {toc.length > 0 && (
              <nav className="sticky top-28">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-medium tracking-wide text-fg-3 uppercase">{t('legal.onThisPage')}</h2>
                  <span className="tabular text-xs text-fg-4">{Math.round(progress * 100)}%</span>
                </div>
                <div className="mb-3 h-0.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full bg-linear-to-r from-brand-a to-brand-b transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
                </div>
                <div className="max-h-[calc(100vh-14rem)] overflow-y-auto">{tocList()}</div>
              </nav>
            )}
          </aside>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
