import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { useReducedMotion } from './motion';

const TAU = Math.PI * 2;
const SHADES = 8;
const FRAME_MS = 1000 / 30;

interface Particle {
  u: number;
  v: number;
  stream: number;
  radius: number;
  accent: boolean;
  phase: number;
}

/** 贯穿首屏上下边缘的纵向粒子流；离屏停帧，减少动态效果时保留静态构图。 */
export function VerticalParticles({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let visible = true;
    let lastFrame = 0;
    let time = 4;
    let particles: Particle[] = [];
    let foreground = '';
    let accent = '';
    const pointer = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };

    const readColors = () => {
      const style = getComputedStyle(canvas);
      foreground = style.color;
      accent = style.getPropertyValue('--brand-c').trim() || foreground;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!width || !height) return;

      const paths = Array.from({ length: SHADES * 2 }, () => new Path2D());

      for (const particle of particles) {
        const u = (particle.u + time * (particle.stream ? 0.024 : 0.032)) % 1;
        const v = particle.v;
        const bend = u * TAU * 0.92 - time * 0.13 + particle.stream * 2.2;
        const depth = Math.sin(bend) * v;
        const perspective = 1 / (1 - depth * 0.16);
        const centerX = width * (0.61 + particle.stream * 0.035)
          + Math.sin(u * TAU * 0.85 + time * 0.11 + particle.stream * 0.65) * width * 0.14;
        const spread = width * (particle.stream ? 0.23 : 0.3);
        const screenX = centerX + Math.cos(bend) * v * spread * perspective
          + Math.sin(particle.phase) * width * 0.009 + pointer.x * (12 + depth * 8);
        // 循环接缝放在画布外，粒子从顶部持续流入并从底部离开。
        const screenY = u * (height + 160) - 80 + pointer.y * 8;
        if (screenX < -3 || screenX > width + 3 || screenY < -3 || screenY > height + 3) continue;

        const edge = 1 - Math.pow(Math.abs(v), 4) * 0.75;
        const shimmer = 0.9 + Math.sin(time * 0.6 + particle.phase) * 0.1;
        const alpha = edge * shimmer * (0.53 + depth * 0.22) * (particle.stream ? 0.66 : 1);
        const shade = Math.min(SHADES - 1, Math.max(0, Math.floor(alpha * SHADES)));
        const radius = particle.radius * perspective;
        const path = paths[shade + (particle.accent ? SHADES : 0)]!;
        path.moveTo(screenX + radius, screenY);
        path.arc(screenX, screenY, radius, 0, TAU);
      }

      // 按颜色、透明度合并绘制，避免每颗粒子单独提交一次填充。
      for (let color = 0; color < 2; color++) {
        ctx.fillStyle = color ? accent : foreground;
        for (let shade = 0; shade < SHADES; shade++) {
          ctx.globalAlpha = (shade + 0.5) / SHADES;
          ctx.fill(paths[color * SHADES + shade]!);
        }
      }
      ctx.globalAlpha = 1;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, width < 640 ? 1.5 : 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      const rows = width < 640 ? 90 : 120;
      const columns = width < 640 ? 12 : 28;
      if (particles.length !== rows * columns * 2) {
        particles = Array.from({ length: rows * columns * 2 }, (_, index) => {
          const row = Math.floor(index / columns) % rows;
          const column = index % columns;
          return {
            u: (row + Math.random() * 0.7) / rows,
            v: ((column + Math.random() * 0.8) / columns - 0.5) * 2,
            stream: Math.floor(index / (rows * columns)),
            radius: 0.6 + Math.random() * 0.5,
            accent: Math.random() < 0.18,
            phase: Math.random() * TAU,
          };
        });
      }
      draw();
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastFrame < FRAME_MS - 0.5) return;
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.06) : 0;
      lastFrame = now;
      time += dt;
      pointer.x += (target.x - pointer.x) * Math.min(1, dt * 3);
      pointer.y += (target.y - pointer.y) * Math.min(1, dt * 3);
      draw();
    };

    const syncAnimation = () => {
      cancelAnimationFrame(raf);
      lastFrame = 0;
      if (!reduced && visible && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      target.x = (event.clientX / window.innerWidth - 0.5) * 2;
      target.y = (event.clientY / window.innerHeight - 0.5) * 2;
    };
    const resetPointer = () => { target.x = 0; target.y = 0; };
    const onThemeChange = () => { readColors(); draw(); };

    readColors();
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      syncAnimation();
    });
    intersectionObserver.observe(canvas);
    const themeObserver = new MutationObserver(onThemeChange);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    colorScheme.addEventListener('change', onThemeChange);
    document.addEventListener('visibilitychange', syncAnimation);
    if (!reduced) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', resetPointer);
    }
    syncAnimation();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver.disconnect();
      colorScheme.removeEventListener('change', onThemeChange);
      document.removeEventListener('visibilitychange', syncAnimation);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', resetPointer);
    };
  }, [reduced]);

  return <canvas ref={ref} aria-hidden className={cn('pointer-events-none text-fg-2', className)} />;
}
