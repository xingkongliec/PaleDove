// 系统镜像选择：上面是系统类型（发行版），下面是所选系统的各个版本，都是带勾选的卡片；手机上一行一个
import { Circle, CircleCheck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ImageDTO } from '../shared/index';
import { OsIcon } from '@/components/status';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

type Img = Pick<ImageDTO, 'id' | 'name' | 'family'> & { arch?: string };

interface Group {
  family: string;
  /** 各版本名称共同的开头，如 “Ubuntu”“openSUSE” */
  label: string;
  items: Array<Img & { version: string }>;
}

/** 按发行版分组（保持后台的排序），版本名 = 去掉共同开头后的部分 */
function groupImages(images: Img[]): Group[] {
  const map = new Map<string, Img[]>();
  for (const i of images) {
    const key = i.family.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), i]);
  }
  return [...map.entries()].map(([family, list]) => {
    const words = list.map((i) => i.name.trim().split(/\s+/));
    let n = 0;
    while (words.every((w) => w.length > n + (list.length > 1 ? 0 : -1) && w[n] === words[0]![n])) n++;
    // 只有一个版本时整个名称都是标题
    const label = list.length > 1 && n > 0 ? words[0]!.slice(0, n).join(' ') : list[0]!.name;
    return { family, label, items: list.map((i, idx) => ({ ...i, version: list.length > 1 ? words[idx]!.slice(n).join(' ') || i.name : '' })) };
  });
}

export function ImagePicker({
  images,
  value,
  onChange,
  current,
  currentLabel,
  'aria-label': ariaLabel,
  className,
}: {
  images: Img[];
  value: number | null;
  onChange: (id: number) => void;
  /** 实例当前使用的镜像（重装系统页标注“当前”） */
  current?: number | null;
  currentLabel?: ReactNode;
  'aria-label'?: string;
  className?: string;
}) {
  const t = useT();
  const groups = useMemo(() => groupImages(images), [images]);
  // 每个发行版记住上次选的版本：切换发行版再切回来时保持
  const [picked, setPicked] = useState<Record<string, number>>({});
  // 默认选这个发行版排序第一的版本（按后台镜像排序）
  const chosenOf = (g: Group) => g.items.find((i) => i.id === value) ?? g.items.find((i) => i.id === picked[g.family]) ?? g.items[0]!;
  const choose = (g: Group, id: number) => {
    setPicked((p) => ({ ...p, [g.family]: id }));
    onChange(id);
  };
  const active = groups.find((g) => g.items.some((i) => i.id === value));

  return (
    <div className={cn('space-y-3', className)}>
      <div className="text-xs text-fg-3">{t('image.family')}</div>
      {/* 系统类型：手机一行一个，宽屏按宽度自动排列 */}
      <div role="radiogroup" aria-label={ariaLabel} className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]">
        {groups.map((g) => {
          const selected = g === active;
          const isCurrent = current != null && g.items.some((i) => i.id === current);
          return (
            <button
              key={g.family}
              type="button"
              role="radio"
              aria-checked={selected}
              title={g.items.length > 1 ? `${g.label} · ${g.items.map((i) => i.version).join(' / ')}` : g.label}
              onClick={() => !selected && choose(g, chosenOf(g).id)}
              className={cn(
                'flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg border px-3 text-[14px] outline-none transition-[border-color,background-color] duration-150 focus-visible:ring-3 focus-visible:ring-ring',
                selected ? 'border-primary bg-surface-2 font-semibold text-fg ring-1 ring-primary' : 'border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg',
              )}
            >
              <OsIcon family={g.family} className="size-6 rounded border-0 bg-transparent text-[10px]" />
              <span className="truncate">{g.label}</span>
              {isCurrent && currentLabel && <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] leading-4 font-normal text-fg-3">{currentLabel}</span>}
              {selected && <CircleCheck className="size-4 shrink-0 text-fg-2" />}
            </button>
          );
        })}
      </div>
      {/* 系统版本：所选系统的各个版本，带单选圈 */}
      {active && (
        <>
          <div className="pt-1 text-xs text-fg-3">{t('image.versionLabel')}</div>
          <div role="radiogroup" aria-label={t('image.version', { name: active.label })} className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">
            {active.items.map((i) => {
              const on = i.id === value;
              return (
                <button
                  key={i.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => choose(active, i.id)}
                  className={cn(
                    'flex h-11 min-w-0 items-center gap-2.5 rounded-lg border px-3 text-left text-[14px] outline-none transition-[border-color,background-color] duration-150 focus-visible:ring-3 focus-visible:ring-ring',
                    on ? 'border-primary bg-surface-2 font-semibold text-fg' : 'border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg',
                  )}
                >
                  <OsIcon family={active.family} className="size-6 rounded border-0 bg-transparent text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  {/* 同名镜像（不同架构，宿主机架构未知时会同时出现）标出架构 */}
                  {i.arch && active.items.some((x) => x.id !== i.id && x.name === i.name) && <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] leading-4 font-normal text-fg-3">{i.arch}</span>}
                  {current === i.id && currentLabel && <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] leading-4 font-normal text-fg-3">{currentLabel}</span>}
                  {on ? <CircleCheck className="size-[18px] shrink-0 text-fg-2" /> : <Circle className="size-[18px] shrink-0 text-fg-4" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
