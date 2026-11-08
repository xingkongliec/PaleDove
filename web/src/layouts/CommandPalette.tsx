import { Dialog } from '@base-ui/react/dialog';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search, Server } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { InstanceDTO, Paginated } from '../shared/index';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { NavGroup } from './AppShell';

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  to: string;
}

/** 全局搜索（Ctrl / ⌘ + K）：页面、快捷操作与实例 */
export function CommandPalette({
  open,
  onOpenChange,
  nav,
  area,
  extra,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  nav: NavGroup[];
  area: 'user' | 'admin';
  extra?: { label: string; to: string; icon: ReactNode }[];
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const term = q.trim().toLowerCase();
  const instances = useQuery({
    queryKey: ['palette-instances', area, area === 'admin' ? term : ''],
    enabled: open,
    staleTime: 15_000,
    queryFn: async () =>
      area === 'admin'
        ? (await api.get<Paginated<InstanceDTO>>('/admin/instances', { q: term || undefined, pageSize: 8 })).items
        : await api.get<InstanceDTO[]>('/instances'),
  });

  const entries = useMemo<Entry[]>(() => {
    const pages: Entry[] = nav.flatMap((g) =>
      g.items.map((it) => ({ id: `p:${it.to}`, group: t('shell.pages'), label: t(it.label), hint: g.title ? t(g.title) : undefined, icon: it.icon, to: it.to })),
    );
    const actions: Entry[] = (extra ?? []).map((a) => ({ id: `a:${a.to}`, group: t('shell.quickActions'), label: a.label, icon: a.icon, to: a.to }));
    const match = (s?: string | null) => !!s && s.toLowerCase().includes(term);
    const base = [...actions, ...pages].filter((e) => !term || match(e.label) || match(e.hint));
    const inst: Entry[] = (instances.data ?? [])
      .filter((i) => area === 'admin' || !term || match(i.name) || match(i.hostname) || match(i.publicIp) || match(i.privateIp))
      .slice(0, 8)
      .map((i) => ({
        id: `i:${i.id}`,
        group: t('shell.instancesGroup'),
        label: i.hostname,
        hint: [i.name, i.publicIp].filter(Boolean).join(' · '),
        icon: <Server />,
        to: area === 'admin' ? `/admin/instances/${i.id}` : `/console/instances/${i.id}`,
      }));
    return [...base, ...inst];
  }, [nav, extra, instances.data, term, area, t]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (e?: Entry) => {
    if (!e) return;
    onOpenChange(false);
    navigate(e.to);
  };

  let lastGroup = '';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop-anim fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Viewport className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
          <Dialog.Popup className="modal-anim flex max-h-[min(26rem,76dvh)] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-surface text-fg shadow-card ring-1 ring-line outline-none">
            <Dialog.Title className="sr-only">{t('shell.search')}</Dialog.Title>
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search className="size-4 shrink-0 text-fg-4" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, entries.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    go(entries[active]);
                  }
                }}
                placeholder={t('shell.searchPlaceholder')}
                aria-label={t('shell.search')}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-4"
              />
              <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-4">Esc</kbd>
            </div>
            <div ref={listRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox">
              {entries.length === 0 && <div className="px-3 py-10 text-center text-[13px] text-fg-3">{t('shell.noResults')}</div>}
              {entries.map((e, i) => {
                const head = e.group !== lastGroup;
                lastGroup = e.group;
                return (
                  <div key={e.id}>
                    {head && <div className="px-2.5 pt-2.5 pb-1 text-xs text-fg-4">{e.group}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      data-active={i === active}
                      onMouseMove={() => setActive(i)}
                      onClick={() => go(e)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors duration-100',
                        i === active ? 'bg-surface-3 text-fg' : 'text-fg-2',
                      )}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-fg-3 [&>svg]:size-4">{e.icon}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-fg">{e.label}</span>
                        {e.hint && <span className="ml-2 text-xs text-fg-4">{e.hint}</span>}
                      </span>
                      {i === active && <CornerDownLeft className="size-3.5 shrink-0 text-fg-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
