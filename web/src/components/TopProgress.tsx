import { useEffect, useRef, useState } from 'react';
import { useGlobalLoading } from '@/lib/loading';

/**
 * 顶部细进度条：加载超过 150ms 才出现（快的请求不闪），进行中缓慢推进到约 85%，
 * 完成时补满并淡出。状态来自 lib/loading（页面代码下载、页面首次取数；单次最多 8 秒）。
 * 两个定时器分开保存：显示延迟只在 loading 变化时处理，淡出定时器不会被状态更新取消。
 */
export function TopProgress() {
  const loading = useGlobalLoading();
  const [phase, setPhase] = useState<'idle' | 'run' | 'done'>('idle');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (loading) {
      window.clearTimeout(hideTimer.current);
      // 正在淡出时立即重新开始；空闲时延迟 150ms，快速完成的加载不显示
      if (phaseRef.current === 'done') setPhase('run');
      else if (phaseRef.current === 'idle') showTimer.current = window.setTimeout(() => setPhase('run'), 150);
    } else {
      window.clearTimeout(showTimer.current);
      if (phaseRef.current === 'run') {
        setPhase('done');
        hideTimer.current = window.setTimeout(() => setPhase('idle'), 400);
      }
    }
  }, [loading]);

  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  if (phase === 'idle') return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5">
      {/* key 让每次重新开始都从头播放推进动画 */}
      <div key={phase} className={phase === 'run' ? 'top-progress-run h-full bg-fg' : 'top-progress-done h-full bg-fg'} />
    </div>
  );
}
