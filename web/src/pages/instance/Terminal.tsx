// 网页终端：浏览器 ⇄ WebSocket ⇄ Incus exec（root shell）。xterm 体积较大，本文件按需加载
import { ContextMenu } from '@base-ui/react/context-menu';
import { Popover } from '@base-ui/react/popover';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ClipboardPaste, Copy, Download, Eraser, Maximize2, Minimize2, Minus, OctagonX, Plus, RefreshCw, RotateCcw, Settings2, SquareTerminal, TextSelect, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type { DockSession } from '@/components/TerminalDock';
import { Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

export type TerminalStatus = 'connecting' | 'connected' | 'closed';
type Status = TerminalStatus;

// ───────────── 终端外观设置（所有终端共用，保存在本地） ─────────────

const THEMES = {
  dark: { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#e5e5e5', selectionBackground: '#404040' },
  tomorrow: { background: '#1d1f21', foreground: '#c5c8c6', cursor: '#c5c8c6', selectionBackground: '#373b41' },
  solarized: { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#073642' },
  // 浅色底：把白色系 ANSI 颜色调深，避免白字看不见
  light: { background: '#fafafa', foreground: '#262626', cursor: '#262626', selectionBackground: '#d4d4d4', white: '#525252', brightWhite: '#262626', yellow: '#a16207', brightYellow: '#854d0e' },
} satisfies Record<string, ITheme>;
type ThemeKey = keyof typeof THEMES;

const FONTS = {
  default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  consolas: 'Consolas, "Courier New", monospace',
  menlo: 'Menlo, Monaco, monospace',
  courier: '"Courier New", Courier, monospace',
} as const;
type FontKey = keyof typeof FONTS;

interface TermPrefs {
  fontSize: number;
  lineHeight: number;
  font: FontKey;
  theme: ThemeKey;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  /** 选中文字后自动复制 */
  copyOnSelect: boolean;
}

const LINE_HEIGHTS = [[1, 'tight'], [1.15, 'normal'], [1.3, 'relaxed'], [1.5, 'loose']] as const;

const PREFS_KEY = 'pd-terminal-prefs';
const FONT_MIN = 10;
const FONT_MAX = 24;
const DEFAULT_PREFS: TermPrefs = { fontSize: 13, lineHeight: 1, font: 'default', theme: 'dark', cursorStyle: 'block', cursorBlink: true, copyOnSelect: false };

function loadPrefs(): TermPrefs {
  try {
    const v = { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<TermPrefs>) };
    // 旧版本只保存了字号
    const legacy = Number(localStorage.getItem('pd-terminal-font'));
    if (legacy && !localStorage.getItem(PREFS_KEY)) v.fontSize = legacy;
    return {
      ...v,
      fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, Number(v.fontSize) || DEFAULT_PREFS.fontSize)),
      theme: v.theme in THEMES ? v.theme : 'dark',
      font: v.font in FONTS ? v.font : 'default',
    };
  } catch {
    // 无法读取本地存储时使用默认设置
    return DEFAULT_PREFS;
  }
}

let prefs = loadPrefs();
const listeners = new Set<() => void>();

function setPrefs(patch: Partial<TermPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 设置只在本次会话生效
  }
  listeners.forEach((l) => l());
}

function useTermPrefs(): TermPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

/** 终端背景色：外层容器与终端保持一致 */
export function useTerminalBackground(): string {
  return THEMES[useTermPrefs().theme].background;
}

/** 由外部（设置面板）调用的终端操作 */
export interface TerminalHandle {
  clear: () => void;
  interrupt: () => void;
  selectAll: () => void;
  /** 把回滚缓冲区里的全部输出保存为文本文件 */
  download: (name: string) => void;
}

/** 终端设置面板：窗口右上角的齿轮按钮，外观设置对所有终端生效，下方是当前终端的快捷操作 */
export function TerminalSettings({ handle, name, className }: { handle: () => TerminalHandle | null; name: string; className?: string }) {
  const { t } = useI18n();
  const p = useTermPrefs();
  const [open, setOpen] = useState(false);
  const act = (fn: (h: TerminalHandle) => void) => () => {
    const h = handle();
    if (h) fn(h);
    setOpen(false);
  };
  const row = 'flex items-center justify-between gap-3';
  const label = 'shrink-0 text-[13px] text-fg-2';
  const step = 'flex size-7 items-center justify-center rounded-md border border-line text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40 [&>svg]:size-3.5';
  const action = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg [&>svg]:size-3.5 [&>svg]:text-fg-3';
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={t('terminal.settings')}
        title={t('terminal.settings')}
        className={cn('rounded p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white data-popup-open:bg-neutral-800 data-popup-open:text-white', className)}
      >
        <Settings2 className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[70]">
          <Popover.Popup className="popup-anim w-72 rounded-md border border-line bg-surface p-3 text-fg shadow-card outline-none">
            <Popover.Title className="mb-2.5 text-[13px] font-semibold">{t('terminal.settings')}</Popover.Title>
            <div className="space-y-2.5">
              <div className={row}>
                <span className={label}>{t('terminal.fontSize')}</span>
                <div className="flex items-center gap-1.5">
                  <button type="button" className={step} disabled={p.fontSize <= FONT_MIN} onClick={() => setPrefs({ fontSize: p.fontSize - 1 })} aria-label={t('terminal.menu.zoomOut')}>
                    <Minus />
                  </button>
                  <span className="tabular w-10 text-center text-[13px] font-medium">{p.fontSize}px</span>
                  <button type="button" className={step} disabled={p.fontSize >= FONT_MAX} onClick={() => setPrefs({ fontSize: p.fontSize + 1 })} aria-label={t('terminal.menu.zoomIn')}>
                    <Plus />
                  </button>
                </div>
              </div>
              <div className={row}>
                <span className={label}>{t('terminal.lineHeight')}</span>
                <Select<number>
                  className="h-8 w-36"
                  value={p.lineHeight}
                  onChange={(v) => setPrefs({ lineHeight: v })}
                  options={LINE_HEIGHTS.map(([v, k]) => ({ value: v, label: `${v}×`, description: t(`terminal.lineHeightDesc.${k}`) }))}
                />
              </div>
              <div className={row}>
                <span className={label}>{t('terminal.font')}</span>
                <Select<FontKey>
                  className="h-8 w-36"
                  value={p.font}
                  onChange={(v) => setPrefs({ font: v })}
                  options={(Object.keys(FONTS) as FontKey[]).map((v) => ({ value: v, label: t(`terminal.font.${v}`), description: t(`terminal.fontDesc.${v}`) }))}
                />
              </div>
              <div className={row}>
                <span className={label}>{t('terminal.theme')}</span>
                <Select<ThemeKey>
                  className="h-8 w-36"
                  value={p.theme}
                  onChange={(v) => setPrefs({ theme: v })}
                  options={(Object.keys(THEMES) as ThemeKey[]).map((v) => ({ value: v, label: t(`terminal.theme.${v}`), description: t(`terminal.themeDesc.${v}`) }))}
                />
              </div>
              <div className={row}>
                <span className={label}>{t('terminal.cursor')}</span>
                <Select<TermPrefs['cursorStyle']>
                  className="h-8 w-36"
                  value={p.cursorStyle}
                  onChange={(v) => setPrefs({ cursorStyle: v })}
                  options={(['block', 'bar', 'underline'] as const).map((v) => ({ value: v, label: t(`terminal.cursor.${v}`), description: t(`terminal.cursorDesc.${v}`) }))}
                />
              </div>
              <Switch checked={p.cursorBlink} onCheckedChange={(v) => setPrefs({ cursorBlink: v })} label={t('terminal.cursorBlink')} />
              <Switch checked={p.copyOnSelect} onCheckedChange={(v) => setPrefs({ copyOnSelect: v })} label={t('terminal.copyOnSelect')} description={t('terminal.copyOnSelectHint')} />
            </div>
            <div className="-mx-1 mt-3 grid grid-cols-2 gap-0.5 border-t border-line pt-2">
              <button type="button" className={action} onClick={act((h) => h.clear())}>
                <Eraser />
                {t('terminal.menu.clear')}
              </button>
              <button type="button" className={action} onClick={act((h) => h.interrupt())}>
                <OctagonX />
                {t('terminal.menu.interrupt')}
              </button>
              <button type="button" className={action} onClick={act((h) => h.download(name))}>
                <Download />
                {t('terminal.download')}
              </button>
              <button type="button" className={action} onClick={() => setPrefs(DEFAULT_PREFS)}>
                <RotateCcw />
                {t('terminal.resetPrefs')}
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 终端本体：挂载时建立连接，卸载时断开。url 为 /api 之后的路径；右键打开操作菜单 */
export function WebTerminal({
  url,
  onStatus,
  onReconnect,
  active = true,
  handle,
}: {
  url: string;
  onStatus: (s: Status) => void;
  onReconnect?: () => void;
  active?: boolean;
  handle?: Ref<TerminalHandle>;
}) {
  const { t } = useI18n();
  const p = useTermPrefs();
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sendRef = useRef<(msg: object) => void>(() => undefined);
  const [hasSelection, setHasSelection] = useState(false);
  const status = useRef(onStatus);
  status.current = onStatus;

  const copy = () => {
    const text = termRef.current?.getSelection();
    if (text) void navigator.clipboard?.writeText(text).catch(() => toast.error(t('terminal.clipboardDenied')));
    termRef.current?.focus();
  };
  const paste = () => {
    if (!navigator.clipboard?.readText) return toast.error(t('terminal.clipboardDenied'));
    navigator.clipboard
      .readText()
      .then((text) => text && termRef.current?.paste(text))
      .catch(() => toast.error(t('terminal.clipboardDenied')))
      .finally(() => termRef.current?.focus());
  };
  const clear = () => {
    termRef.current?.clear();
    termRef.current?.focus();
  };
  const interrupt = () => {
    sendRef.current({ type: 'input', data: '\x03' });
    termRef.current?.focus();
  };
  useImperativeHandle(handle, () => ({
    clear,
    interrupt,
    selectAll: () => termRef.current?.selectAll(),
    download: (name: string) => {
      const term = termRef.current;
      if (!term) return;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      const blob = new Blob([lines.join('\n').replace(/\n+$/, '\n')], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
  }));

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      fontFamily: FONTS[prefs.font],
      cursorBlink: prefs.cursorBlink,
      cursorStyle: prefs.cursorStyle,
      scrollback: 5000,
      theme: THEMES[prefs.theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    if (el.clientWidth && el.clientHeight) fit.fit();
    term.focus();
    status.current('connecting');
    term.write(`\x1b[90m${t('terminal.connecting')}\x1b[0m\r\n`);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api${url}${url.includes('?') ? '&' : '?'}cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => status.current('connected');
    // 终端输出是二进制（原样交给 xterm 解码 UTF-8），提示信息是文本
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => {
      status.current('closed');
      term.write(`\r\n\x1b[90m[${t('terminal.closed')}]\x1b[0m\r\n`);
    };
    ws.onerror = () => term.write(`\r\n\x1b[31m${t('terminal.connectFailed')}\x1b[0m\r\n`);
    const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    sendRef.current = send;
    const sub = term.onData((data) => send({ type: 'input', data }));
    // 选中即复制（设置里开启）
    const selSub = term.onSelectionChange(() => {
      const text = prefs.copyOnSelect ? term.getSelection() : '';
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
    });
    // Ctrl+Shift+C / Ctrl+Shift+V 复制粘贴（Ctrl+C 仍发送中断信号）
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        copy();
        return false;
      }
      if (e.code === 'KeyV') {
        e.preventDefault();
        paste();
        return false;
      }
      return true;
    });
    const ro = new ResizeObserver(() => {
      // 隐藏的会话（切换到其他标签）尺寸为 0，不调整，避免把终端缩成最小
      if (!el.clientWidth || !el.clientHeight) return;
      try {
        fit.fit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      } catch {
        // 终端已卸载
      }
    });
    ro.observe(el);
    termRef.current = term;
    fitRef.current = fit;
    return () => {
      ro.disconnect();
      sub.dispose();
      selSub.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sendRef.current = () => undefined;
    };
    // 只在地址变化（重新连接）时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  // 设置变化时更新已打开的终端，字号 / 行距变化后重新计算行列数
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    Object.assign(term.options, { fontSize: p.fontSize, lineHeight: p.lineHeight, fontFamily: FONTS[p.font], cursorBlink: p.cursorBlink, cursorStyle: p.cursorStyle, theme: THEMES[p.theme] });
    const el = ref.current;
    if (!el?.clientWidth || !el.clientHeight) return;
    try {
      fitRef.current?.fit();
      sendRef.current({ type: 'resize', cols: term.cols, rows: term.rows });
    } catch {
      // 终端已卸载
    }
  }, [p]);
  // 切换到该会话时把输入焦点交给终端
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  const item =
    'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 outline-none select-none data-disabled:cursor-not-allowed data-disabled:opacity-40 data-highlighted:bg-neutral-800 [&>svg]:size-4 [&>svg]:text-neutral-400';
  const kbd = 'ml-auto pl-4 font-mono text-[11px] text-neutral-500';
  return (
    <ContextMenu.Root onOpenChange={(open) => open && setHasSelection(!!termRef.current?.hasSelection())}>
      <div className="h-full w-full p-2" style={{ background: THEMES[p.theme].background }}>
        <ContextMenu.Trigger render={<div ref={ref} className="h-full w-full overflow-hidden" />} />
      </div>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[80] outline-none">
          <ContextMenu.Popup className="popup-anim min-w-48 rounded-lg border border-neutral-700 bg-neutral-900 p-1 text-[13px] text-neutral-200 shadow-2xl outline-none">
            <ContextMenu.Item className={item} disabled={!hasSelection} onClick={copy}>
              <Copy />
              {t('terminal.menu.copy')}
              <span className={kbd}>Ctrl+Shift+C</span>
            </ContextMenu.Item>
            <ContextMenu.Item className={item} onClick={paste}>
              <ClipboardPaste />
              {t('terminal.menu.paste')}
              <span className={kbd}>Ctrl+Shift+V</span>
            </ContextMenu.Item>
            <ContextMenu.Item className={item} onClick={() => termRef.current?.selectAll()}>
              <TextSelect />
              {t('terminal.menu.selectAll')}
            </ContextMenu.Item>
            <ContextMenu.Separator className="mx-1 my-1 h-px bg-neutral-800" />
            <ContextMenu.Item className={item} onClick={clear}>
              <Eraser />
              {t('terminal.menu.clear')}
            </ContextMenu.Item>
            <ContextMenu.Item className={item} onClick={interrupt}>
              <OctagonX />
              {t('terminal.menu.interrupt')}
              <span className={kbd}>Ctrl+C</span>
            </ContextMenu.Item>
            {onReconnect && (
              <>
                <ContextMenu.Separator className="mx-1 my-1 h-px bg-neutral-800" />
                <ContextMenu.Item className={item} onClick={onReconnect}>
                  <RefreshCw />
                  {t('terminal.reconnect')}
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// ───────────── 实例终端窗口（由 TerminalDock 管理） ─────────────

const statusDot = (s: Status) => cn('size-2.5 shrink-0 rounded-full', s === 'connected' ? 'bg-success' : s === 'connecting' ? 'animate-pulse bg-warning' : 'bg-neutral-500');

/** 终端窗口：叉号缩小为小窗口（不断开），缩小后保持挂载以维持连接 */
function TerminalWindow({ session, status, onStatus, onUpdate }: { session: DockSession; status: Status; onStatus: (s: Status) => void; onUpdate: (patch: Partial<DockSession>) => void }) {
  const { t } = useI18n();
  const [full, setFull] = useState(false);
  const handle = useRef<TerminalHandle>(null);
  const background = useTerminalBackground();
  const minimize = () => onUpdate({ minimized: true });
  const reconnect = () => onUpdate({ nonce: session.nonce + 1 });
  const iconBtn = 'rounded p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white';
  return (
    <div className={cn('fixed inset-0 z-50', session.minimized && 'pointer-events-none invisible')} aria-hidden={session.minimized}>
      <div className="absolute inset-0 bg-black/50" onClick={minimize} />
      <div
        role="dialog"
        aria-modal={!session.minimized}
        aria-label={t('terminal.title', { name: session.hostname })}
        style={{ background }}
        className={cn(
          'absolute flex flex-col overflow-hidden shadow-2xl',
          full ? 'inset-0' : 'top-1/2 left-1/2 h-[78dvh] w-[calc(100%-32px)] max-w-6xl -translate-x-1/2 -translate-y-1/2 rounded-lg ring-1 ring-white/10',
        )}
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 bg-[#0a0a0a] px-4 py-2 text-neutral-200">
          <span className={statusDot(status)} aria-hidden />
          <span className="min-w-0 truncate text-[13px] font-medium">{t('terminal.title', { name: session.hostname })}</span>
          <span className="hidden text-xs text-neutral-500 sm:inline">{t(`terminal.status.${status}`)}</span>
          <div className="ml-auto flex items-center gap-1">
            <TerminalSettings handle={() => handle.current} name={session.hostname} />
            <button type="button" aria-label={t('terminal.reconnect')} title={t('terminal.reconnect')} onClick={reconnect} className={iconBtn}>
              <RefreshCw className="size-4" />
            </button>
            <button
              type="button"
              aria-label={full ? t('terminal.exitFullscreen') : t('terminal.fullscreen')}
              title={full ? t('terminal.exitFullscreen') : t('terminal.fullscreen')}
              onClick={() => setFull(!full)}
              className={cn(iconBtn, 'hidden sm:block')}
            >
              {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
            <button type="button" aria-label={t('terminal.minimize')} title={t('terminal.minimize')} onClick={minimize} className={iconBtn}>
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <WebTerminal key={session.nonce} handle={handle} url={`${session.path}/terminal`} active={!session.minimized} onStatus={onStatus} onReconnect={reconnect} />
        </div>
      </div>
    </div>
  );
}

/** 缩小后的小窗口：简约的小条（状态点、图标、主机名），拖动改变位置，单击打开终端，叉号关闭连接 */
function MiniWindow({ session, status, index, onRestore, onClose, onMoved }: { session: DockSession; status: Status; index: number; onRestore: () => void; onClose: () => void; onMoved: (pos: { x: number; y: number }) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // 从会话里恢复上次拖动到的位置（小窗口在打开终端时会卸载，位置保存在会话上）
  const [pos, setPos] = useState<{ x: number; y: number } | null>(session.miniPos ?? null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  // 限制在可视区域内
  const clamp = (x: number, y: number) => {
    const el = ref.current!;
    return { x: Math.min(Math.max(8, x), window.innerWidth - el.offsetWidth - 8), y: Math.min(Math.max(8, y), window.innerHeight - el.offsetHeight - 8) };
  };
  // 恢复的位置可能因窗口尺寸变化超出可视区域：挂载后收回到可视范围内
  useEffect(() => {
    if (pos) setPos(clamp(pos.x, pos.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      title={t('terminal.restore')}
      aria-label={t('terminal.restore')}
      // 未拖动过时停靠在右下角，多个小窗口向上排列
      style={pos ? { left: pos.x, top: pos.y } : { right: 20, bottom: 20 + index * 52 }}
      className={cn(
        'group fixed z-[60] flex h-11 w-64 max-w-[calc(100vw-2.5rem)] touch-none items-center gap-2.5 rounded-lg border border-line bg-surface pr-1.5 pl-3.5 text-fg shadow-md outline-none select-none',
        'cursor-pointer transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring active:cursor-grabbing',
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        // 移动超过几个像素才算拖动，否则视为单击
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        setPos(clamp(d.ox + dx, d.oy + dy));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) onRestore();
        // 拖动结束时记下位置
        else if (d && pos) onMoved(pos);
      }}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onRestore()}
    >
      {/* 简约样式：状态圆点（悬停显示状态文字）+ 终端图标 + 主机名 */}
      <span className={statusDot(status)} title={t(`terminal.status.${status}`)} aria-label={t(`terminal.status.${status}`)} />
      <SquareTerminal className="size-[18px] shrink-0 text-fg-2" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-fg">{session.hostname}</span>
      <button
        type="button"
        aria-label={t('terminal.closeSession')}
        title={t('terminal.closeSession')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** 全部实例终端：展开的窗口与右下角的小窗口；所有会话保持挂载，缩小时不断开 */
export default function TerminalWindows({
  sessions,
  onUpdate,
  onClose,
}: {
  sessions: DockSession[];
  onUpdate: (key: number, patch: Partial<DockSession>) => void;
  onClose: (key: number) => void;
}) {
  const [status, setStatus] = useState<Record<number, Status>>({});
  const minimized = sessions.filter((s) => s.minimized);
  return createPortal(
    <>
      {sessions.map((s) => (
        <TerminalWindow
          key={s.key}
          session={s}
          status={status[s.key] ?? 'connecting'}
          onStatus={(st) => setStatus((m) => ({ ...m, [s.key]: st }))}
          onUpdate={(patch) => onUpdate(s.key, patch)}
        />
      ))}
      {minimized.map((s, i) => (
        <MiniWindow
          key={s.key}
          session={s}
          index={i}
          status={status[s.key] ?? 'connecting'}
          onRestore={() => onUpdate(s.key, { minimized: false })}
          onClose={() => onClose(s.key)}
          onMoved={(miniPos) => onUpdate(s.key, { miniPos })}
        />
      ))}
    </>,
    document.body,
  );
}
