import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LegalKind, MaintenanceSettings } from '../shared/index.ts';
import { getSetting, setSetting } from '../lib/settings.ts';
import { adminGuard, logActivity, panelUrl, parse, requireAdmin } from '../lib/http.ts';
import { badRequest } from '../lib/errors.ts';
import { prisma } from '../lib/prisma.ts';
import { m, t } from '../i18n/index.ts';
import { adminLegal, DEFAULT_LEGAL, LEGAL_KINDS, LEGAL_MAX_LENGTH, LEGAL_TITLES, publicLegal } from '../services/legal.ts';
import { emailAnnouncement } from '../services/announcements.ts';
import { withLock } from '../lib/redis.ts';
import { DOCUMENTS_LOCK } from '../services/documents.ts';

/** 公告里的维护时间：按服务器时区显示为 2026-10-18 21:00 */
const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: process.env.TZ || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso))
    .replaceAll('/', '-');

export async function publicLegalRoutes(app: FastifyInstance) {
  app.get('/api/public/legal/:kind', async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(LEGAL_KINDS) }), req.params);
    return publicLegal(kind, panelUrl(req));
  });
}

export default async function settingsOperationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  app.get('/api/admin/settings/maintenance', async () => getSetting('maintenance'));
  app.put('/api/admin/settings/maintenance', async (req) => {
    const date = z.string().refine((v) => Number.isFinite(Date.parse(v)), m('maintenance.invalidDate'));
    const { announce, announceEmail, ...body } = parse(z.object({
      enabled: z.boolean(), title: z.string().trim().min(1, m('maintenance.titleRequired')).max(80), message: z.string().trim().max(2000), scope: z.enum(['NOTICE', 'READONLY', 'FULL']),
      startAt: date.nullable(), endAt: date.nullable(), updates: z.array(z.object({ at: date, text: z.string().trim().min(1).max(500) })).max(50),
      autoSchedule: z.boolean().default(false), previewHours: z.number().int().min(0).max(168).default(24), allowEmails: z.array(z.string().trim().toLowerCase().pipe(z.email(m('v.email')))).max(100).default([]),
      announce: z.boolean().default(false), announceEmail: z.boolean().default(false),
    }), req.body);
    if (body.startAt && body.endAt && Date.parse(body.endAt) <= Date.parse(body.startAt)) throw badRequest(t('maintenance.endAfterStart'));
    if (body.autoSchedule && !body.startAt) throw badRequest(t('maintenance.startRequired'));
    const prev = await getSetting('maintenance');
    const next: MaintenanceSettings = { ...body, startedAt: body.enabled ? prev.enabled && prev.startedAt ? prev.startedAt : new Date().toISOString() : null, allowEmails: [...new Set(body.allowEmails)], updates: [...body.updates].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
    await setSetting('maintenance', next);
    await logActivity(req, requireAdmin(req).id, 'admin.maintenance', JSON.stringify({ enabled: next.enabled, autoSchedule: next.autoSchedule, scope: next.scope, title: next.title }));
    if (announce) {
      const range = body.startAt ? `\n\n${t('maintenance.time')}${fmtTime(body.startAt)}${body.endAt ? ` ～ ${fmtTime(body.endAt)}` : ''}` : '';
      const a = await prisma.announcement.create({ data: { title: t('maintenance.announcementTitle', { title: body.title }), content: (body.message || body.title) + range, level: body.scope === 'FULL' ? 'CRITICAL' : 'WARNING', expiresAt: body.endAt ? new Date(Date.parse(body.endAt) + 86_400_000) : null } });
      await logActivity(req, requireAdmin(req).id, 'admin.announcement_create', a.title);
      if (announceEmail) void emailAnnouncement(a, panelUrl(req)).catch((error) => req.log.error({ err: error }, 'announcement email failed'));
    }
    return next;
  });
  app.get('/api/admin/settings/legal', async () => adminLegal(await getSetting('legal')));
  app.put('/api/admin/settings/legal', async (req) => withLock(DOCUMENTS_LOCK, 15_000, async () => {
    const doc = z.object({ content: z.string().max(LEGAL_MAX_LENGTH) });
    const body = parse(z.object({ terms: doc, privacy: doc, requireAgree: z.boolean(), announce: z.boolean().default(false), announceEmail: z.boolean().default(false) }), req.body);
    const current = await getSetting('legal', true);
    const now = new Date().toISOString();
    const changed: LegalKind[] = [];
    const next = { ...current, requireAgree: body.requireAgree };
    for (const kind of LEGAL_KINDS) {
      const text = body[kind].content.replace(/\r\n?/g, '\n').trim();
      const content = !text || text === DEFAULT_LEGAL[kind].trim() ? '' : text;
      const before = (current[kind].content || DEFAULT_LEGAL[kind]).trim();
      const after = (content || DEFAULT_LEGAL[kind]).trim();
      if (before !== after) changed.push(kind);
      next[kind] = { content, updatedAt: before !== after ? now : current[kind].updatedAt };
    }
    await setSetting('legal', next);
    await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify({ changed, requireAgree: next.requireAgree }));
    if (body.announce && changed.length) {
      const what = changed.map((kind) => LEGAL_TITLES[kind]).join('、');
      const links = changed.map((kind) => `${LEGAL_TITLES[kind]}：${panelUrl(req)}/${kind}`).join('\n');
      const a = await prisma.announcement.create({ data: { title: t('legal.announcementTitle', { what }), content: t('legal.announcementBody', { what, links }), level: 'INFO' } });
      await logActivity(req, requireAdmin(req).id, 'admin.announcement_create', a.title);
      if (body.announceEmail) void emailAnnouncement(a, panelUrl(req)).catch((error) => req.log.error({ err: error }, 'announcement email failed'));
    }
    return { ...adminLegal(next), changed };
  }));
}
