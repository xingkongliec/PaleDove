import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { useReducedMotion } from './motion';

/** 球面上的点数（斐波那契网格，分布均匀） */
const DOTS = 1800;
/** 数据中心节点数与同时飞行的连线上限 */
const NODES = 12;
const MAX_ARCS = 5;
/** 球体绕 X 轴的倾斜（弧度）：略微俯视 */
const TILT = 0.42;

type Vec = [number, number, number];

/** 读取 CSS 颜色字符串（rgb(...) 或 #rrggbb）为 [r, g, b] */
function readRgb(value: string, fallback: Vec): Vec {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (hex) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const m = /(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/.exec(value);
  return m ? [Math.round(+m[1]!), Math.round(+m[2]!), Math.round(+m[3]!)] : fallback;
}

const rgba = (c: Vec, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** 两个单位向量之间的球面插值 */
function slerp(a: Vec, b: Vec, t: number): Vec {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-4) return a;
  const s = Math.sin(omega);
  const ka = Math.sin((1 - t) * omega) / s;
  const kb = Math.sin(t * omega) / s;
  return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
}

interface Arc {
  from: number;
  to: number;
  /** 进度：0 → 1 飞行，1 之后尾迹收拢 */
  t: number;
  speed: number;
}

/**
 * 数据地球：点阵组成的球体缓慢自转，球面上分布若干「数据中心」节点（品牌色、呼吸光环），
 * 节点之间不断飞出弧形数据连线，抵达时目标节点泛起一圈光波；鼠标移动时有轻微视差。
 * 球心位于画布右下方，呈「地平线升起」的构图。Canvas 2D 绘制，颜色取自当前主题；
 * 不可见 / 标签页隐藏时暂停，系统要求减少动画时只绘制静止的一帧。
 */
export function DataGlobe({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // 斐波那契球面网格
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dots: Vec[] = Array.from({ length: DOTS }, (_, i) => {
      const y = 1 - (i / (DOTS - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const a = i * golden;
      return [Math.cos(a) * r, y, Math.sin(a) * r];
    });
    // 节点放在北半球与赤道附近（构图上可见的部分）
    const nodes: { p: Vec; phase: number }[] = Array.from({ length: NODES }, () => {
      const lat = (Math.random() * 0.75 - 0.05) * (Math.PI / 2);
      const lon = Math.random() * Math.PI * 2;
      return { p: [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)] as Vec, phase: Math.random() * Math.PI * 2 };
    });
    const arcs: Arc[] = [];
    /** 抵达光波：节点序号与开始时间 */
    const ripples: { node: number; start: number }[] = [];

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let onScreen = true;
    let frame = 0;
    let fg: Vec = [128, 128, 128];
    let accent: Vec = [96, 120, 220];
    let accent2: Vec = [160, 110, 240];
    let last = performance.now();
    let time = 0;
    let spawnAt = 0;
    let target = { x: 0, y: 0 };
    let parallax = { x: 0, y: 0 };

    const readColors = () => {
      const root = getComputedStyle(document.documentElement);
      fg = readRgb(getComputedStyle(canvas).color, fg);
      accent = readRgb(root.getPropertyValue('--brand-a'), fg);
      accent2 = readRgb(root.getPropertyValue('--brand-b'), accent);
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };

    /** 当前姿态下的投影：返回屏幕坐标与朝向（z > 0 为正面） */
    const geometry = () => {
      // 宽画布：球心在右下方，「地平线升起」；窄画布（手机）：较小的球体放在右上角
      const narrow = w < 640;
      const R = narrow ? Math.min(w * 0.42, h * 0.78) : Math.max(120, Math.min(h * 1.02, w * 0.42));
      const cx = (narrow ? w * 0.8 : w * 0.62) + parallax.x * 18;
      const cy = (narrow ? h * 0.55 : h * 1.12 + R * 0.08) + parallax.y * 10;
      const rot = time * 0.09 + parallax.x * 0.12;
      const tilt = TILT + parallax.y * 0.05;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      const project = (p: Vec, lift = 1) => {
        const x1 = p[0] * cr + p[2] * sr;
        const z1 = -p[0] * sr + p[2] * cr;
        const y2 = p[1] * ct - z1 * st;
        const z2 = p[1] * st + z1 * ct;
        return { x: cx + x1 * R * lift, y: cy - y2 * R * lift, z: z2 };
      };
      return { R, cx, cy, project };
    };

    const spawn = () => {
      if (arcs.length >= MAX_ARCS) return;
      const { project } = geometry();
      // 只在正面且在画布内的节点之间连线
      const visible = nodes.map((n, i) => ({ i, s: project(n.p) })).filter(({ s }) => s.z > 0.15 && s.y > 0 && s.y < h && s.x > w * 0.2 && s.x < w);
      if (visible.length < 2) return;
      const a = visible[Math.floor(Math.random() * visible.length)]!.i;
      let b = a;
      while (b === a) b = visible[Math.floor(Math.random() * visible.length)]!.i;
      arcs.push({ from: a, to: b, t: 0, speed: 0.45 + Math.random() * 0.3 });
    };

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!w || !h) return;
      ctx.scale(dpr, dpr);
      const { R, cx, cy, project } = geometry();

      // 大气光晕
      const glow = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 1.22);
      glow.addColorStop(0, rgba(accent, 0));
      glow.addColorStop(0.35, rgba(accent, 0.14));
      glow.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // 球面点阵：正面越靠近视线越亮，背面极淡
      for (const p of dots) {
        const s = project(p);
        if (s.y < -4 || s.y > h + 4 || s.x < -4 || s.x > w + 4) continue;
        if (s.z <= 0) {
          if (s.z < -0.35) continue;
          ctx.globalAlpha = 0.05;
        } else {
          ctx.globalAlpha = 0.12 + s.z * 0.5;
        }
        ctx.fillStyle = rgba(fg, 1);
        const size = 0.8 + Math.max(0, s.z) * 0.9;
        ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;

      // 数据连线：沿大圆抬升的弧线，尾迹渐隐，头部发光
      ctx.lineCap = 'round';
      for (const arc of arcs) {
        const a = nodes[arc.from]!.p;
        const b = nodes[arc.to]!.p;
        const head = Math.min(1, arc.t);
        const tail = Math.max(0, arc.t - 0.45);
        const steps = 28;
        let prev: { x: number; y: number } | null = null;
        for (let k = 0; k <= steps; k++) {
          const u = tail + ((head - tail) * k) / steps;
          const lift = 1 + Math.sin(Math.PI * u) * 0.22;
          const s = project(slerp(a, b, u), lift);
          if (prev) {
            const f = k / steps;
            ctx.strokeStyle = rgba(f > 0.5 ? accent : accent2, 0.08 + f * 0.75);
            ctx.lineWidth = 0.6 + f * 1.3;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(s.x, s.y);
            ctx.stroke();
          }
          prev = s;
        }
        if (arc.t < 1 && prev) {
          const halo = ctx.createRadialGradient(prev.x, prev.y, 0, prev.x, prev.y, 7);
          halo.addColorStop(0, rgba(accent, 0.9));
          halo.addColorStop(1, rgba(accent, 0));
          ctx.fillStyle = halo;
          ctx.fillRect(prev.x - 7, prev.y - 7, 14, 14);
        }
      }

      // 数据中心节点：呼吸光环 + 抵达光波
      nodes.forEach((n, i) => {
        const s = project(n.p);
        if (s.z <= 0.05 || s.y > h + 10) return;
        const breathe = 0.5 + 0.5 * Math.sin(time * 1.6 + n.phase);
        ctx.fillStyle = rgba(accent, 0.12 * s.z * (0.6 + breathe));
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5 + breathe * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(accent, 0.55 + 0.45 * s.z);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.9, 0, Math.PI * 2);
        ctx.fill();
        for (const r of ripples) {
          if (r.node !== i) continue;
          const age = time - r.start;
          ctx.strokeStyle = rgba(accent, Math.max(0, 0.6 * (1 - age / 1.2)) * s.z);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 3 + age * 18, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    };

    const step = (dt: number) => {
      time += dt;
      for (const arc of arcs) {
        const before = arc.t;
        arc.t += dt * arc.speed;
        if (before < 1 && arc.t >= 1) ripples.push({ node: arc.to, start: time });
      }
      for (let i = arcs.length - 1; i >= 0; i--) if (arcs[i]!.t > 1.45) arcs.splice(i, 1);
      for (let i = ripples.length - 1; i >= 0; i--) if (time - ripples[i]!.start > 1.2) ripples.splice(i, 1);
      if (time >= spawnAt) {
        spawn();
        spawnAt = time + 0.55 + Math.random() * 0.9;
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!onScreen || document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = Math.min(1, dt * 3);
      parallax = { x: parallax.x + (target.x - parallax.x) * k, y: parallax.y + (target.y - parallax.y) * k };
      if (frame++ % 90 === 0) readColors();
      step(dt);
      draw();
    };
    const onMove = (e: PointerEvent) => {
      target = { x: (e.clientX / window.innerWidth - 0.5) * 2, y: (e.clientY / window.innerHeight - 0.5) * 2 };
    };

    resize();
    readColors();
    // 静止帧也带几条连线，减少动画时同样好看
    for (let i = 0; i < 40; i++) step(0.1);
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
