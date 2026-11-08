import { Fragment, useMemo, type ReactNode } from 'react';
import { cn as cx } from '@/lib/cn';

/**
 * 精简的 Markdown 渲染：标题、段落、有序 / 无序列表、引用、分隔线，行内粗体、斜体、代码、链接和网址自动识别。
 * 只生成 React 元素、不解析 HTML，管理员填写的内容不会注入脚本；链接只允许 http(s) / mailto / 站内路径。
 * 段落内的换行按原样保留（中文内容按空格拼接会多出空格）。
 */

type Block =
  | { type: 'h'; level: number; text: string; id: string }
  | { type: 'p'; lines: string[] }
  | { type: 'ul' | 'ol'; items: string[]; start: number }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; content: string; language: string }
  | { type: 'hr' };

export interface MdHeading {
  id: string;
  level: number;
  text: string;
}

const UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})([^`~]*)$/;

export function parseMarkdown(src: string): { blocks: Block[]; headings: MdHeading[] } {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const headings: MdHeading[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const code: string[] = [];
      const marker = fence[1]!;
      const close = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i]!)) code.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', content: code.join('\n'), language: fence[2]!.trim() });
      continue;
    }
    const h = /^\s{0,3}(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const id = `s-${headings.length + 1}`;
      const text = h[2]!;
      blocks.push({ type: 'h', level: h[1]!.length, text, id });
      headings.push({ id, level: h[1]!.length, text: stripInline(text) });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }
    const isUl = UL_RE.test(line);
    const ol = OL_RE.exec(line);
    if (isUl || ol) {
      const re = isUl ? UL_RE : OL_RE;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = re.exec(cur);
        if (m) items.push(isUl ? m[1]! : m[2]!);
        // 缩进的续行并入上一项
        else if (/^\s{2,}\S/.test(cur) && items.length) items[items.length - 1] += '\n' + cur.trim();
        else break;
        i++;
      }
      blocks.push({ type: isUl ? 'ul' : 'ol', items, start: ol ? Number(ol[1]) : 1 });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s{0,3}(#{1,4}\s|>)/.test(lines[i]!) && !FENCE_RE.test(lines[i]!) && !HR_RE.test(lines[i]!) && !UL_RE.test(lines[i]!) && !OL_RE.test(lines[i]!)) para.push(lines[i++]!.trim());
    blocks.push({ type: 'p', lines: para });
  }
  return { blocks, headings };
}

const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(https?:\/\/[^\s<>()（）《》，。；、]+)/g;

function safeHref(url: string) {
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url) ? url : null;
}

function stripInline(text: string) {
  return text.replace(INLINE_RE, (_m, b, c, lt, _lu, it, url) => b ?? c ?? lt ?? it ?? url ?? '');
}

function MdLink({ href, children }: { href: string; children: ReactNode }) {
  const external = /^(https?:|mailto:)/i.test(href);
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className="font-medium text-fg underline decoration-slate-300 underline-offset-[3px] transition-colors hover:decoration-fg">
      {children}
    </a>
  );
}

function inline(text: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const [, bold, code, linkText, linkUrl, italic, url] = m;
    if (bold !== undefined) out.push(<strong key={k} className="font-semibold text-fg">{inline(bold, k)}</strong>);
    else if (code !== undefined) out.push(<code key={k} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.9em]">{code}</code>);
    else if (linkText !== undefined) {
      const href = safeHref(linkUrl!);
      out.push(href ? <MdLink key={k} href={href}>{inline(linkText, k)}</MdLink> : <Fragment key={k}>{linkText}</Fragment>);
    } else if (italic !== undefined) out.push(<em key={k}>{inline(italic, k)}</em>);
    else if (url !== undefined) out.push(<MdLink key={k} href={url}>{url}</MdLink>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 多行文字：行之间插入换行 */
function lines(list: string[], key: string) {
  return list.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(l, `${key}-${i}`)}
    </Fragment>
  ));
}

const H_CLS: Record<number, string> = {
  1: 'mt-10 mb-4 text-2xl font-semibold tracking-tight',
  2: 'mt-10 mb-3 text-lg font-semibold tracking-tight',
  3: 'mt-7 mb-2 text-[15px] font-semibold',
  4: 'mt-5 mb-2 text-[14px] font-semibold',
};

export function Markdown({ source, className }: { source: string; className?: string }) {
  const { blocks } = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={cx('text-[14.5px] leading-7 text-fg-2 [&>:first-child]:mt-0', className)}>
      {blocks.map((b, i) => {
        const k = String(i);
        switch (b.type) {
          case 'h': {
            const Tag = `h${b.level}` as 'h1';
            return (
              <Tag key={k} id={b.id} className={cx('scroll-mt-20 text-fg', H_CLS[b.level])}>
                {inline(b.text, k)}
              </Tag>
            );
          }
          case 'hr':
            return <hr key={k} className="my-8 border-line" />;
          case 'code':
            return <div key={k} className="my-4 overflow-hidden rounded-lg border border-line bg-surface-2">{b.language && <div className="border-b border-line px-4 py-1.5 font-mono text-xs text-fg-3">{b.language}</div>}<pre className="overflow-x-auto px-4 py-3 text-[13px] leading-6"><code>{b.content}</code></pre></div>;
          case 'quote':
            return (
              <blockquote key={k} className="my-4 border-l-2 border-slate-300 pl-4 text-fg-3">
                {lines(b.lines, k)}
              </blockquote>
            );
          case 'ul':
          case 'ol': {
            const List = b.type;
            return (
              <List key={k} start={b.type === 'ol' && b.start !== 1 ? b.start : undefined} className={cx('my-3 space-y-1.5 pl-6', b.type === 'ul' ? 'list-disc marker:text-slate-400' : 'list-decimal marker:text-slate-500')}>
                {b.items.map((it, j) => (
                  <li key={j} className="pl-1">
                    {lines(it.split('\n'), `${k}-${j}`)}
                  </li>
                ))}
              </List>
            );
          }
          default:
            return (
              <p key={k} className="my-3">
                {lines(b.lines, k)}
              </p>
            );
        }
      })}
    </div>
  );
}
