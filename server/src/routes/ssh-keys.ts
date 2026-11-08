// 账号的 SSH 公钥：只保存公钥；密钥对在浏览器本地生成，私钥不经过服务器
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SshKeyDTO } from '../shared/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { consoleGuard, idParam, logActivity, parse, requireUser } from '../lib/http.ts';
import { prisma, type SshKey } from '../lib/prisma.ts';
import { m, t } from '../i18n/index.ts';

const MAX_KEYS = 20;
const KEY_TYPES = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/** 读取 SSH wire 格式里的一个 string 字段（4 字节长度 + 内容） */
function readString(buf: Buffer, offset: number): [Buffer, number] {
  if (offset + 4 > buf.length) throw new Error('truncated');
  const len = buf.readUInt32BE(offset);
  if (offset + 4 + len > buf.length) throw new Error('truncated');
  return [buf.subarray(offset + 4, offset + 4 + len), offset + 4 + len];
}

/** 解析一行 OpenSSH 公钥：校验类型与内容一致，计算 SHA256 指纹（与 ssh-keygen -lf 相同）和 RSA 位数 */
export function parsePublicKey(line: string): { type: string; publicKey: string; comment: string; fingerprint: string; bits: number | null } {
  const [type, data, ...rest] = line.trim().split(/\s+/);
  if (!type || !data || !KEY_TYPES.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw badRequest(t('v.sshKey'));
  const blob = Buffer.from(data, 'base64');
  let bits: number | null = null;
  try {
    const [inner, next] = readString(blob, 0);
    if (inner.toString() !== type) throw new Error('type mismatch');
    if (type === 'ssh-rsa') {
      const [, afterE] = readString(blob, next);
      const [n] = readString(blob, afterE);
      // 去掉 mpint 开头补的 0
      let i = 0;
      while (i < n.length && n[i] === 0) i++;
      bits = (n.length - i) * 8 - Math.clz32(n[i] ?? 0) + 24;
    }
  } catch {
    throw badRequest(t('v.sshKey'));
  }
  const comment = rest.join(' ');
  return {
    type,
    publicKey: [type, data, comment].filter(Boolean).join(' '),
    comment,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    bits,
  };
}

const view = (k: SshKey): SshKeyDTO => {
  let bits: number | null = null;
  try {
    bits = parsePublicKey(k.publicKey).bits;
  } catch {
    // 保存时已校验过
  }
  return { id: k.id, name: k.name, type: k.type, bits, fingerprint: k.fingerprint, publicKey: k.publicKey, createdAt: k.createdAt.toISOString() };
};

export default async function sshKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);

  app.get('/api/ssh-keys', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.sshKey.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    return rows.map(view);
  });

  app.post('/api/ssh-keys', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ name: z.string().trim().max(64, m('v.tooLong')).optional(), publicKey: z.string().trim().min(1, m('sshKey.required')).max(16_000) }),
      req.body,
    );
    const key = parsePublicKey(body.publicKey);
    if ((await prisma.sshKey.count({ where: { userId: user.id } })) >= MAX_KEYS) throw conflict(t('sshKey.limit', { n: MAX_KEYS }));
    if (await prisma.sshKey.findUnique({ where: { userId_fingerprint: { userId: user.id, fingerprint: key.fingerprint } } })) throw conflict(t('sshKey.duplicate'));
    // 没填名称时用公钥注释（通常是 user@host）
    const name = body.name || key.comment.slice(0, 64) || key.type;
    const row = await prisma.sshKey.create({ data: { userId: user.id, name, publicKey: key.publicKey, type: key.type, fingerprint: key.fingerprint } });
    await logActivity(req, user.id, 'account.ssh_key_add', `${name} ${key.fingerprint}`);
    return view(row);
  });

  app.patch('/api/ssh-keys/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { name } = parse(z.object({ name: z.string().trim().min(1, m('sshKey.nameRequired')).max(64, m('v.tooLong')) }), req.body);
    const row = await prisma.sshKey.findFirst({ where: { id, userId: user.id } });
    if (!row) throw notFound(t('sshKey.notFound'));
    return view(await prisma.sshKey.update({ where: { id }, data: { name } }));
  });

  app.delete('/api/ssh-keys/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await prisma.sshKey.findFirst({ where: { id, userId: user.id } });
    if (!row) throw notFound(t('sshKey.notFound'));
    await prisma.sshKey.delete({ where: { id } });
    await logActivity(req, user.id, 'account.ssh_key_delete', `${row.name} ${row.fingerprint}`);
    return { ok: true };
  });
}
