import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** 用户是否要求减少动画（系统设置） */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** 滚动进入视口时淡入上移（只触发一次），delay 为毫秒 */
export function Reveal({
  as: Tag = 'div',
  delay = 0,
  className,
  style,
  children,
}: {
  as?: ElementType;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} data-shown={shown || undefined} className={cn('reveal', className)} style={{ '--d': delay, ...style } as CSSProperties}>
      {children}
    </Tag>
  );
}

/** 随机游走的实时序列（演示用），每 interval 毫秒推进一个点；减少动画时保持静止 */
export function useLiveSeries(initial: number[], { interval = 1400, min = 8, max = 60, step = 9 } = {}): number[] {
  const reduced = useReducedMotion();
  const [data, setData] = useState(initial);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      setData((prev) => {
        const last = prev[prev.length - 1] ?? (min + max) / 2;
        const next = Math.min(max, Math.max(min, last + (Math.random() - 0.5) * step * 2));
        return [...prev.slice(1), Math.round(next)];
      });
    }, interval);
    return () => window.clearInterval(id);
  }, [reduced, interval, min, max, step]);
  return data;
}

/** 折线与面积路径（0 在底部），值域 [0, top] */
export function sparkPaths(samples: number[], w: number, h: number, top = 70): { line: string; area: string } {
  const stepX = w / (samples.length - 1);
  const pts = samples.map((v, i) => [i * stepX, h - (v / top) * h] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w},${h} L0,${h} Z` };
}
