// 网页终端：浏览器 ⇄ WebSocket ⇄ Incus exec（root 交互式 shell）。实例终端与宿主机运维终端共用。
// 客户端消息：{type:'input',data} / {type:'resize',cols,rows}；服务端发送终端输出（二进制）和提示信息（文本）。
import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import type { TerminalOptions, TerminalSession } from '../incus/types.ts';
import { t } from '../i18n/index.ts';
import { errorMessage } from './errors.ts';
import { parse } from './http.ts';

/** 30 分钟无输入自动断开，避免遗忘的会话一直占用 */
const IDLE_MS = 30 * 60_000;

/**
 * 处理一个终端 WebSocket 连接。
 * open 负责权限与状态检查并打开 Incus 会话；返回字符串表示拒绝连接（作为提示显示给用户），抛出异常显示为「连接失败」
 */
export async function serveTerminal(socket: WebSocket, req: FastifyRequest, open: (opts: TerminalOptions) => Promise<TerminalSession | string>, binary = false): Promise<void> {
  // Incus 连接和审计入库期间，浏览器可能已经回复 VNC 握手，先缓存再交给会话。
  let consume: ((data: Buffer, isBinary: boolean) => void) | null = null;
  const pending: { data: Buffer; isBinary: boolean }[] = [];
  let pendingBytes = 0;
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (consume) return consume(data, isBinary);
    pendingBytes += data.length;
    if (pendingBytes > 1024 * 1024 || pending.length >= 128) return socket.close(1009);
    pending.push({ data, isBinary });
  });
  const notice = (text: string, color = 31) => socket.readyState === socket.OPEN && socket.send(`\r\n\x1b[${color}m${text}\x1b[0m\r\n`);
  const fail = (text: string) => {
    if (!binary) notice(text);
    socket.close(1008, binary ? text.slice(0, 40) : undefined);
  };
  // WebSocket 不受同源策略限制：只接受本站页面发起的连接，防止其他网站借用户的登录状态打开终端
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return fail(t('terminal.forbiddenOrigin'));
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return fail(t('terminal.forbiddenOrigin'));
    } catch { return fail(t('terminal.forbiddenOrigin')); }
  } else if (binary) return fail(t('terminal.forbiddenOrigin'));
  let session: TerminalSession;
  try {
    const q = parse(z.object({ cols: z.coerce.number().int().min(10).max(500).default(120), rows: z.coerce.number().int().min(5).max(200).default(32) }), req.query);
    const opened = await open({
      cols: q.cols,
      rows: q.rows,
      onData: (data) => socket.readyState === socket.OPEN && socket.send(data),
      onExit: (reason) => {
        if (!binary) notice(reason ? t('terminal.endedWith', { reason }) : t('terminal.ended'), 33);
        socket.close();
      },
    });
    if (typeof opened === 'string') return fail(opened);
    session = opened;
  } catch (e) {
    return fail(t('terminal.failed', { error: errorMessage(e) }));
  }
  const s = session;
  // 打开 shell 期间浏览器已断开
  if (socket.readyState !== socket.OPEN) return s.close();
  let idle: NodeJS.Timeout;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (!binary) notice(t('terminal.idle'), 33);
      s.close();
      socket.close();
    }, IDLE_MS);
  };
  touch();
  consume = (raw: Buffer, isBinary: boolean) => {
    if (binary) {
      if (!isBinary || raw.length > 1024 * 1024) return socket.close(1009);
      s.write(raw);
      touch();
      return;
    }
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      if (msg.type === 'input' && typeof msg.data === 'string') {
        s.write(msg.data);
        touch();
      } else if (msg.type === 'resize') {
        const cols = Math.min(500, Math.max(10, Number(msg.cols) || 80));
        const rows = Math.min(200, Math.max(5, Number(msg.rows) || 24));
        s.resize(cols, rows);
      }
    } catch {
      // 忽略非法消息
    }
  };
  for (const msg of pending) consume(msg.data, msg.isBinary);
  pending.length = 0;
  socket.on('close', () => {
    clearTimeout(idle);
    s.close();
  });
}
