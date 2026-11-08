// 个人 API 令牌：创建时只显示一次明文，之后只保存摘要
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiTokenDTO } from '../shared/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';
import { consoleGuard, idParam, logActivity, parse, requireUser } from '../lib/http.ts';
import { prisma, type ApiToken } from '../lib/prisma.ts';
import { m, t } from '../i18n/index.ts';
import { API_TOKEN_PREFIX } from '../plugins/session.ts';

const MAX_TOKENS = 20;

const tokenView = (t: ApiToken): ApiTokenDTO => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  lastUsedIp: t.lastUsedIp,
  expiresAt: t.expiresAt?.toISOString() ?? null,
  readOnly: t.readOnly,
  createdAt: t.createdAt.toISOString(),
});

export default async function tokenRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);

  app.get('/api/tokens', async (req) => {
    const user = requireUser(req);
    const items = await prisma.apiToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    return items.map(tokenView);
  });

  app.post('/api/tokens', async (req) => {
    const user = requireUser(req);
    if (user.role !== 'USER') throw forbidden(t('apiToken.adminForbidden'));
    const body = parse(
      z.object({
        name: z.string().trim().min(1, m('apiToken.nameRequired')).max(40),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable().default(90),
        // 只读：只能调用查询接口
        readOnly: z.boolean().default(false),
      }),
      req.body,
    );
    if ((await prisma.apiToken.count({ where: { userId: user.id } })) >= MAX_TOKENS) throw conflict(t('apiToken.limit', { n: MAX_TOKENS }));
    const token = `${API_TOKEN_PREFIX}${randomToken(30)}`;
    const row = await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: body.name,
        tokenHash: sha256(token),
        prefix: token.slice(0, 10),
        readOnly: body.readOnly,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null,
      },
    });
    await logActivity(req, user.id, 'account.api_token_create', body.readOnly ? `${body.name} (read-only)` : body.name);
    // 明文只在这里返回一次
    return { ...tokenView(row), token };
  });

  app.delete('/api/tokens/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await prisma.apiToken.findFirst({ where: { id, userId: user.id } });
    if (!row) throw notFound(t('apiToken.notFound'));
    await prisma.apiToken.delete({ where: { id: row.id } });
    await logActivity(req, user.id, 'account.api_token_delete', row.name);
    return { ok: true };
  });
}
