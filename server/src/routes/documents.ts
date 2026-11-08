import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminGuard, logActivity, panelUrl, parse, requireAdmin } from '../lib/http.ts';
import { getSetting, setSetting } from '../lib/settings.ts';
import { withLock } from '../lib/redis.ts';
import { prisma } from '../lib/prisma.ts';
import { m, t } from '../i18n/index.ts';
import { LEGAL_MAX_LENGTH } from '../services/legal.ts';
import { adminDocuments, deleteDocument, deleteDocumentCategory, DOCUMENTS_LOCK, publicDocument, publicDocuments, saveDocument, saveDocumentCategory } from '../services/documents.ts';
import { emailAnnouncement } from '../services/announcements.ts';

const slug = z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, m('documents.invalidSlug'));
const fields = z.object({
  title: z.string().trim().min(1).max(120), slug, content: z.string().max(LEGAL_MAX_LENGTH),
  categoryId: z.string().min(1).max(80), order: z.number().int().min(-10000).max(10000),
  published: z.boolean(), pinned: z.boolean(), announce: z.boolean().default(false), announceEmail: z.boolean().default(false),
});
const categoryFields = z.object({ name: z.string().trim().min(1).max(60), order: z.number().int().min(-10000).max(10000) });
const idOf = (params: unknown) => parse(z.object({ id: z.string().min(1).max(80) }), params).id;

export async function publicDocumentRoutes(app: FastifyInstance) {
  app.get('/api/public/documents', publicDocuments);
  app.get('/api/public/documents/:slug', async req => {
    const params = parse(z.object({ slug }), req.params);
    return publicDocument(params.slug, panelUrl(req));
  });
}

export default async function documentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  app.get('/api/admin/documents', adminDocuments);
  app.patch('/api/admin/documents/settings', async req => {
    const body = parse(z.object({ requireAgree: z.boolean() }), req.body);
    await withLock(DOCUMENTS_LOCK, 15_000, async () => {
      await getSetting('legal', true);
      return setSetting('legal', body);
    });
    await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify(body));
    return adminDocuments();
  });
  app.post('/api/admin/documents/categories', async req => {
    const category = await saveDocumentCategory(null, parse(categoryFields, req.body));
    await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify({ action: 'category.create', title: category.name }));
    return category;
  });
  app.patch('/api/admin/documents/categories/:id', async req => {
    const category = await saveDocumentCategory(idOf(req.params), parse(categoryFields, req.body));
    await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify({ action: 'category.update', title: category.name }));
    return category;
  });
  app.delete('/api/admin/documents/categories/:id', async req => {
    const id = idOf(req.params);
    await deleteDocumentCategory(id);
    await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify({ action: 'category.delete', id }));
    return { ok: true };
  });
  for (const method of ['POST', 'PATCH'] as const) {
    app.route({ method, url: method === 'POST' ? '/api/admin/documents' : '/api/admin/documents/:id', handler: async req => {
      const { announce, announceEmail, ...body } = parse(fields, req.body);
      const { doc, changed } = await saveDocument(method === 'POST' ? null : idOf(req.params), body);
      await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify({ action: method === 'POST' ? 'document.create' : 'document.update', id: doc.id, title: doc.title }));
      if (announce && changed && doc.published) {
        const url = `${panelUrl(req)}${doc.kind ? `/${doc.kind}` : `/help/${doc.slug}`}`;
        const a = await prisma.announcement.create({ data: { title: t('legal.announcementTitle', { what: doc.title }), content: t('legal.announcementBody', { what: doc.title, links: `${doc.title}：${url}` }), level: 'INFO' } });
        await logActivity(req, requireAdmin(req).id, 'admin.announcement_create', a.title);
        if (announceEmail) void emailAnnouncement(a, panelUrl(req)).catch(error => req.log.error({ err: error }, 'document announcement email failed'));
      }
      return doc;
    } });
  }
  app.delete('/api/admin/documents/:id', async req => {
    const doc = await deleteDocument(idOf(req.params));
    await logActivity(req, requireAdmin(req).id, 'admin.legal', JSON.stringify({ action: 'document.delete', id: doc.id, title: doc.title }));
    return { ok: true };
  });
}
