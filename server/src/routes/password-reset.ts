import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, randomToken, sha256 } from '../lib/crypto.ts';
import { badRequest } from '../lib/errors.ts';
import { logActivity, mailBaseUrl, parse } from '../lib/http.ts';
import { prisma } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { destroyUserSessions } from '../plugins/session.ts';
import { m, t } from '../i18n/index.ts';
import { sendResetEmail, isMailConfigured } from '../services/mail/mailer.ts';
import { getSetting } from '../lib/settings.ts';

export default async function passwordResetRoutes(app: FastifyInstance) {
  app.post('/api/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().pipe(z.email(m('v.email'))) }), req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    // 未配置邮件、账号不存在或禁用时同样返回，避免泄露账号信息。
    if (user?.status === 'ACTIVE' && isMailConfigured(await getSetting('mail'))) {
      await withLock(`password-reset:${user.id}`, 30_000, async () => {
        const last = await prisma.passwordResetToken.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        if (last && Date.now() - last.createdAt.getTime() < 60_000) return;
        const token = randomToken(32);
        await prisma.$transaction(async (tx) => {
          await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
          await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
        });
        await sendResetEmail(user, token, mailBaseUrl(req));
      }).catch((error) => req.log.error({ err: error }, 'password reset email failed'));
    }
    return { ok: true };
  });
  app.post('/api/auth/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(16).max(128), password: z.string().min(8, m('v.passwordMin')).max(128, m('v.passwordTooLong')) }), req.body);
    const passwordHash = await hashPassword(body.password);
    const userId = await prisma.$transaction(async (tx) => {
      const row = await tx.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) }, include: { user: true } });
      if (!row || row.usedAt || row.expiresAt <= new Date() || row.user.status !== 'ACTIVE') throw badRequest(t('mail.resetExpired'));
      const used = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (!used.count) throw badRequest(t('mail.resetExpired'));
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } });
      return row.userId;
    });
    await destroyUserSessions(userId);
    // 账号可能已被盗用：令牌也一并吊销（攻击者可能建过令牌）
    await prisma.apiToken.deleteMany({ where: { userId } });
    await logActivity(req, userId, 'auth.password_reset');
    return { ok: true };
  });
}
