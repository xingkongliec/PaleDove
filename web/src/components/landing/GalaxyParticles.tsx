import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { useReducedMotion } from './motion';

const COUNT = 9600;
const ARMS = 3;
/** 盘面绕 X 轴倾斜的角度（弧度）：越大越接近侧视 */
const TILT = 1.02;

interface Star {
  /** 半径（占盘面半径的比例，0~1）；星系外飘散的尘埃可以大于 1 */
  r: number;
  /** 起始角度 */
  a: number;
  /** 离盘面的高度（占盘面半径的比例） */
  z: number;
  size: number;
  /** 闪烁的相位与速度 */
  phase: number;
  speed: number;
  accent: boolean;
}

/** 读取 CSS 颜色字符串（rgb(...) 或 #rrggbb）为 [r, g, b] */
function readRgb(value: string, fallback: [number, number, number]): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (hex) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const m = /(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/.exec(value);
  return m ? [Math.round(+m[1]!), Math.round(+m[2]!), Math.round(+m[3]!)] : fallback;
}

/** 近似正态分布的随机数（-1 ~ 1，三个均匀随机数之和） */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

/**
 * 首屏右侧的粒子星河：几千颗粒子组成三条旋臂的星系，内圈转得快、外圈转得慢，
 * 中心发光，粒子缓慢闪烁；鼠标移动时整体有轻微的视差。Canvas 2D 绘制，颜色取自当前主题
 * （前景色与品牌色）；不可见 / 标签页隐藏时暂停，系统要求减少动画时只绘制静止的一帧。
 */
export function GalaxyParticles({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const stars: Star[] = Array.from({ length: COUNT }, (_, i) => {
      // 88% 在星系盘内，12% 是盘外飘散的尘埃
      const dust = i % 8 === 0;
      const r = dust ? 0.35 + Math.random() * 1.15 : Math.pow(Math.random(), 0.62);
      const arm = Math.floor(Math.random() * ARMS);
      // 旋臂：角度随半径增大而扭转；离臂中心越远越松散
      const swirl = r * 5.2;
      const scatter = dust ? Math.random() * Math.PI * 2 : gauss() * (0.22 + r * 0.52);
      return {
        r,
        a: dust ? scatter : (arm * Math.PI * 2) / ARMS + swirl + scatter,
        z: gauss() * (dust ? 0.18 : 0.05 + (1 - r) * 0.05),
        size: dust ? 0.6 + Math.random() * 0.8 : 0.6 + Math.random() * 1.4 * (1.2 - r * 0.6),
        phase: Math.random() * Math.PI * 2,
        speed: 0.6 + Math.random() * 1.6,
        accent: Math.random() < 0.09,
      };
    });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let onScreen = true;
    let frame = 0;
    let fg: [number, number, number] = [128, 128, 128];
    let accent: [number, number, number] = [96, 120, 220];
    let last = performance.now();
    let time = 0;
    // 鼠标相对画布中心的偏移（-1 ~ 1），平滑跟随
    let target = { x: 0, y: 0 };
    let parallax = { x: 0, y: 0 };

    const readColors = () => {
      fg = readRgb(getComputedStyle(canvas).color, fg);
      accent = readRgb(getComputedStyle(document.documentElement).getPropertyValue('--brand-a'), fg);
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!w || !h) return;
      ctx.scale(dpr, dpr);
      const radius = Math.min(w * 0.46, h * 0.82);
      const cx = w * 0.54 + parallax.x * 26;
      const cy = h * 0.5 + parallax.y * 20;
      // 鼠标位置让盘面轻微倾斜
      const tilt = TILT + parallax.y * 0.08;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      const roll = -0.38 + parallax.x * 0.05;
      const cosR = Math.cos(roll);
      const sinR = Math.sin(roll);

      // 中心的光晕
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.5);
      glow.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]},0.22)`);
      glow.addColorStop(0.45, `rgba(${accent[0]},${accent[1]},${accent[2]},0.07)`);
      glow.addColorStop(1, `rgba(${accent[0]},${accent[1]},${accent[2]},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

      for (const s of stars) {
        // 内圈转得快、外圈转得慢
        const angle = s.a + time * (0.32 / (0.35 + s.r * 1.6));
        const x0 = Math.cos(angle) * s.r * radius;
        const y0 = Math.sin(angle) * s.r * radius;
        const z0 = s.z * radius;
        // 绕 X 轴倾斜，再在屏幕平面内旋转
        const y1 = y0 * cosT - z0 * sinT;
        const depth = y0 * sinT + z0 * cosT;
        const sx = cx + x0 * cosR - y1 * sinR;
        const sy = cy + x0 * sinR + y1 * cosR;
        if (sx < -6 || sx > w + 6 || sy < -6 || sy > h + 6) continue;
        // 越靠近中心越亮；闪烁；靠前的略大
        const core = 1 - Math.min(1, s.r);
        const twinkle = 0.62 + 0.38 * Math.sin(time * s.speed + s.phase);
        const near = 0.85 + (depth / radius) * 0.3;
        const alpha = (0.2 + core * 0.7) * twinkle;
        const color = s.accent || core > 0.9 ? accent : fg;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
        const size = s.size * near * (1 + core * 0.5);
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!onScreen || document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      const k = Math.min(1, dt * 3);
      parallax = { x: parallax.x + (target.x - parallax.x) * k, y: parallax.y + (target.y - parallax.y) * k };
      // 主题切换后颜色变化：每隔一段时间重新读取
      if (frame++ % 90 === 0) readColors();
      draw();
    };
    const onMove = (e: PointerEvent) => {
      target = { x: (e.clientX / window.innerWidth - 0.5) * 2, y: (e.clientY / window.innerHeight - 0.5) * 2 };
    };

    resize();
    readColors();
    time = 3;
    draw();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = !!entry?.isIntersecting;
    });
    io.observe(canvas);
    if (!reduced) {
      raf = requestAnimationFrame(tick);
      window.addEventListener('pointermove', onMove, { passive: true });
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
    };
  }, [reduced]);

  return <canvas ref={ref} aria-hidden className={cn('pointer-events-none text-fg', className)} />;
}
