// 实例终端窗口管理：关闭窗口时缩小为右下角可拖动的小窗口，连接保持；Provider 卸载（离开实例管理页面）时全部断开。
// 这里只保存会话状态，终端界面（xterm）在第一次打开时才按需加载
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export interface DockSession {
  key: number;
  instanceId: number;
  hostname: string;
  /** 实例接口路径（/instances/1 或 /admin/instances/1） */
  path: string;
  minimized: boolean;
  /** 重新连接时递增 */
  nonce: number;
  /** 小窗口被拖动后的位置；打开终端再缩小时回到这里（未拖动过时停靠在右下角） */
  miniPos?: { x: number; y: number };
}

interface DockApi {
  /** 打开实例终端：已有连接时恢复窗口，否则新建连接 */
  open: (inst: { id: number; hostname: string }, path: string) => void;
}

const DockContext = createContext<DockApi | null>(null);
const TerminalWindows = lazy(() => import('@/pages/instance/Terminal'));

export function useTerminalDock(): DockApi {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error('useTerminalDock must be used inside TerminalDockProvider');
  return ctx;
}

export function TerminalDockProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<DockSession[]>([]);
  const seq = useRef(0);

  const open = useCallback((inst: { id: number; hostname: string }, path: string) => {
    setSessions((list) => {
      // 同一时间只展开一个窗口
      const others = list.map((s) => ({ ...s, minimized: true }));
      const hit = others.find((s) => s.path === path);
      if (hit) return others.map((s) => (s === hit ? { ...s, minimized: false } : s));
      return [...others, { key: ++seq.current, instanceId: inst.id, hostname: inst.hostname, path, minimized: false, nonce: 0 }];
    });
  }, []);
  const api = useMemo(() => ({ open }), [open]);

  const update = useCallback((key: number, patch: Partial<DockSession>) => {
    setSessions((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : patch.minimized === false ? { ...s, minimized: true } : s)));
  }, []);
  const close = useCallback((key: number) => setSessions((list) => list.filter((s) => s.key !== key)), []);

  return (
    <DockContext.Provider value={api}>
      {children}
      {sessions.length > 0 && (
        <Suspense fallback={null}>
          <TerminalWindows sessions={sessions} onUpdate={update} onClose={close} />
        </Suspense>
      )}
    </DockContext.Provider>
  );
}
