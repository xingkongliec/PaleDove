import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_MAX_FILES, TICKET_MAX_FILE_BYTES, ticketNumber, type TicketDTO, type TicketDetailDTO } from '../shared/index.ts';
import { adminGuard, consoleGuard, ensureFound, idParam, logActivity, pageQuery, paging, parse, requireUser, panelUrl } from '../lib/http.ts';
import { badRequest, forbidden, conflict } from '../lib/errors.ts';
import { prisma, containsInsensitive, type Prisma } from '../lib/prisma.ts';
import { getSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { sendTicketEmail } from '../services/mail/mailer.ts';
import { openTicketFile, removeTicketFile, saveTicketFile } from '../services/ticket-files.ts';
import { toAvatar } from '../services/serializers.ts';

const userSelect = { id: true, username: true, name: true, email: true, avatarStyle: true, avatarVariant: true } as const;
const attachmentSelect = { id: true, fileName: true, mimeType: true, size: true, createdAt: true } as const;
const include = { user: { select: userSelect }, messages: { orderBy: { id: 'desc' }, take: 1 }, _count: { select: { messages: true, attachments: true } } } satisfies Prisma.TicketInclude;
type TicketRow = Prisma.TicketGetPayload<{ include: typeof include }>;
const detailInclude = { ...include, messages: { orderBy: { id: 'asc' }, include: { author: { select: { ...userSelect, role: true } }, attachments: { select: attachmentSelect } } } } satisfies Prisma.TicketInclude;
const messageSchema = z.object({ content: z.string().trim().min(1).max(20_000) });
const createSchema = messageSchema.extend({
  subject: z.string().trim().min(2).max(120), category: z.enum(TICKET_CATEGORIES).default('other'),
  priority: z.enum(TICKET_PRIORITIES).default('NORMAL'), resourceRef: z.preprocess((v) => v === '' ? undefined : v, z.coerce.number().int().positive().optional()),
});
const DAILY_BYTES = 200 * 1024 * 1024;
type SavedFile = Awaited<ReturnType<typeof saveTicketFile>>;

async function withForm<T>(req: FastifyRequest, fn: (fields: unknown, files: SavedFile[]) => Promise<T>): Promise<T> {
  const files: SavedFile[] = [];
  try {
    let fields: unknown = req.body;
    if (req.isMultipart()) {
      const values: Record<string, string> = {};
      for await (const part of req.parts({ limits: { fileSize: TICKET_MAX_FILE_BYTES, files: TICKET_MAX_FILES, fields: 20, fieldSize: 80_000, parts: 25 } })) {
        if (part.type === 'file') {
          if (!part.filename) { part.file.resume(); continue; }
          const fileName = part.filename.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(-200);
          files.push(await saveTicketFile(fileName, part.file, () => part.file.truncated));
        } else {
          if (part.valueTruncated || part.fieldnameTruncated || Object.hasOwn(values, part.fieldname)) throw badRequest(t('ticket.invalidForm'));
          values[part.fieldname] = String(part.value ?? '');
        }
      }
      fields = values;
    }
    return await fn(fields, files);
  } catch (error) {
    await Promise.all(files.map((f) => removeTicketFile(f.storageKey).catch((err) => req.log.error({ err }, 'attachment cleanup failed'))));
    const code = (error as { code?: string }).code;
    if (code === 'FST_FILES_LIMIT') throw badRequest(t('ticket.fileCount'));
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest(t('ticket.fileSize'));
    if (code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') throw badRequest(t('ticket.invalidForm'));
    throw error;
  }
}

function dto(ticket: TicketRow, admin: boolean): TicketDTO {
  return {
    id: ticket.id, number: ticketNumber(ticket.id), subject: ticket.subject,
    category: ticket.category as TicketDTO['category'], priority: ticket.priority as TicketDTO['priority'], status: ticket.status as TicketDTO['status'],
    resourceRef: ticket.resourceRef, resourceName: ticket.resourceName,
    createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString(), lastReplyAt: ticket.lastReplyAt.toISOString(), closedAt: ticket.closedAt?.toISOString() ?? null,
    user: { id: ticket.user.id, username: ticket.user.username, name: ticket.user.name, avatar: toAvatar(ticket.user), ...(admin ? { email: ticket.user.email } : {}) },
    counts: ticket._count, lastReply: ticket.messages.length ? { content: ticket.messages.at(-1)!.content.slice(0, 200), isAdmin: ticket.messages.at(-1)!.isAdmin } : null,
  };
}

// 同一上传者的额度检查和创建通过用户行写锁串行执行，避免并发突破上限。
async function checkPosting(tx: Prisma.TransactionClient, userId: number, files: SavedFile[], admin: boolean) {
  await tx.user.update({ where: { id: userId }, data: { updatedAt: new Date() } });
  if (!admin && await tx.ticketMessage.count({ where: { authorId: userId, createdAt: { gte: new Date(Date.now() - 3600_000) } } }) >= 30) throw conflict(t('ticket.postLimit'));
  if (files.length) {
    const used = await tx.ticketAttachment.aggregate({ where: { message: { authorId: userId }, createdAt: { gte: new Date(Date.now() - 86400_000) } }, _sum: { size: true } });
    if ((used._sum.size ?? 0) + files.reduce((sum, file) => sum + file.size, 0) > DAILY_BYTES) throw conflict(t('ticket.dailyLimit'));
  }
}

export default async function ticketRoutes(app: FastifyInstance, { admin = false }: { admin?: boolean }) {
  const notify = async (ticket: { id: number; subject: string; userId: number }, content: string, baseUrl: string) => {
    const recipients = await prisma.user.findMany({ where: { status: 'ACTIVE', ...(admin ? { id: ticket.userId } : { role: 'ADMIN' }) }, select: { email: true, locale: true } });
    for (const user of recipients) await sendTicketEmail(user, ticket, content, !admin, baseUrl).catch((error) => app.log.error({ err: error }, 'ticket email failed'));
  };
  const queueNotify = (req: FastifyRequest, ticket: { id: number; subject: string; userId: number }, content: string) => {
    void notify(ticket, content, panelUrl(req)).catch((error) => app.log.error({ err: error }, 'ticket notification failed'));
  };
  app.addHook('preHandler', admin ? adminGuard : consoleGuard);
  const load = async (id: number, userId: number) => ensureFound(await prisma.ticket.findFirst({ where: { id, ...(admin ? {} : { userId }) } }), t('ticket.notFound'));

  app.get('/stats', async (req) => {
    const user = requireUser(req);
    const groups = await prisma.ticket.groupBy({ by: ['status'], where: admin ? {} : { userId: user.id }, _count: true });
    return Object.fromEntries(TICKET_STATUSES.map((status) => [status, groups.find((group) => group.status === status)?._count ?? 0]));
  });
  app.get('/', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery.extend({ status: z.enum(TICKET_STATUSES).optional(), category: z.enum(TICKET_CATEGORIES).optional(), priority: z.enum(TICKET_PRIORITIES).optional(), q: z.string().trim().max(200).optional() }), req.query);
    const number = Number(q.q?.replace(/^#/, ''));
    const where: Prisma.TicketWhereInput = {
      ...(admin ? {} : { userId: user.id }), ...(q.status ? { status: q.status } : {}), ...(q.category ? { category: q.category } : {}), ...(q.priority ? { priority: q.priority } : {}),
      ...(q.q ? { OR: [ { subject: containsInsensitive(q.q) }, ...(Number.isSafeInteger(number) && number > 10000 ? [{ id: number - 10000 }] : []), ...(admin ? [{ user: { email: containsInsensitive(q.q) } }, { user: { username: containsInsensitive(q.q) } }] : []) ] } : {}),
    };
    const [items, total] = await Promise.all([prisma.ticket.findMany({ where, include, orderBy: [{ lastReplyAt: 'desc' }, { id: 'desc' }], ...paging(q) }), prisma.ticket.count({ where })]);
    return { items: items.map((ticket) => dto(ticket, admin)), total, page: q.page, pageSize: q.pageSize };
  });
  if (!admin) app.post('/', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const user = requireUser(req);
    if (!(await getSettings()).allowTickets) throw forbidden(t('ticket.disabled'));
    const result = await withForm(req, async (fields, files) => {
      const body = parse(createSchema, fields);
      const ticket = await prisma.$transaction(async (tx) => {
        await checkPosting(tx, user.id, files, false);
        if (await tx.ticket.count({ where: { userId: user.id, status: { not: 'CLOSED' } } }) >= 20) throw conflict(t('ticket.openLimit'));
        const resource = body.resourceRef ? ensureFound(await tx.instance.findFirst({ where: { id: body.resourceRef, userId: user.id, status: { notIn: ['DELETED', 'DELETING'] } }, select: { id: true, name: true } }), t('ticket.resourceMissing')) : null;
        const created = await tx.ticket.create({ data: { userId: user.id, subject: body.subject, category: body.category, priority: body.priority, resourceRef: resource?.id, resourceName: resource?.name } });
        const message = await tx.ticketMessage.create({ data: { ticketId: created.id, authorId: user.id, content: body.content } });
        if (files.length) await tx.ticketAttachment.createMany({ data: files.map((f) => ({ ...f, ticketId: created.id, messageId: message.id })) });
        return tx.ticket.findUniqueOrThrow({ where: { id: created.id }, include });
      });
      return { ticket, content: body.content };
    });
    await logActivity(req, user.id, 'ticket.create', String(result.ticket.id));
    queueNotify(req, result.ticket, result.content);
    return dto(result.ticket, admin);
  });
  app.get('/:id', async (req) => {
    const user = requireUser(req); const { id } = parse(idParam, req.params);
    await load(id, user.id);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id }, include: detailInclude });
    const result: TicketDetailDTO = { ...dto(ticket, admin), messages: ticket.messages.map((message) => ({
      id: message.id, content: message.content, createdAt: message.createdAt.toISOString(), isAdmin: message.isAdmin,
      // 用户看到的技术支持消息不显示具体管理员（无头像，前端显示客服图标）
      author: { id: !admin && message.isAdmin ? null : message.author.id, username: !admin && message.isAdmin ? t('ticket.support') : message.author.name || message.author.username, role: message.isAdmin ? 'ADMIN' : 'USER', avatar: !admin && message.isAdmin ? null : toAvatar(message.author) },
      attachments: message.attachments.map((attachment) => ({ ...attachment, createdAt: attachment.createdAt.toISOString() })),
    })) };
    return result;
  });
  app.post('/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req); const { id } = parse(idParam, req.params);
    const ticket = await load(id, user.id);
    const content = await withForm(req, async (fields, files) => {
      const body = parse(messageSchema.extend({ close: z.union([z.boolean(), z.enum(['0', '1'])]).optional() }), fields);
      if (!admin && body.close !== undefined) throw forbidden();
      await prisma.$transaction(async (tx) => {
        await checkPosting(tx, user.id, files, admin);
        const close = admin && (body.close === true || body.close === '1');
        const now = new Date();
        const updated = await tx.ticket.updateMany({ where: { id, status: { not: 'CLOSED' } }, data: { status: close ? 'CLOSED' : admin ? 'REPLIED' : 'OPEN', lastReplyAt: now, closedAt: close ? now : null } });
        if (!updated.count) throw conflict(t('ticket.closed'));
        await tx.ticketMessage.create({ data: { ticketId: id, authorId: user.id, isAdmin: admin, content: body.content, attachments: { create: files.map((f) => ({ ...f, ticketId: id })) } } });
      });
      return body.content;
    });
    await logActivity(req, user.id, 'ticket.reply', String(id));
    queueNotify(req, ticket, content);
    return { ok: true };
  });
  app.patch('/:id', async (req) => {
    const user = requireUser(req); const { id } = parse(idParam, req.params);
    await load(id, user.id);
    const schema = admin ? z.object({ status: z.enum(TICKET_STATUSES).optional(), priority: z.enum(TICKET_PRIORITIES).optional(), category: z.enum(TICKET_CATEGORIES).optional() }).strict().refine((body) => Object.keys(body).length > 0) : z.object({ status: z.enum(['OPEN', 'CLOSED']) }).strict();
    const body = parse(schema, req.body);
    await prisma.$transaction(async (tx) => {
      if (!admin && body.status === 'OPEN') {
        await tx.user.update({ where: { id: user.id }, data: { updatedAt: new Date() } });
        const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
        if (ticket.status !== 'CLOSED') throw conflict(t('ticket.notClosed'));
        if (await tx.ticket.count({ where: { userId: user.id, status: { not: 'CLOSED' } } }) >= 20) throw conflict(t('ticket.openLimit'));
      }
      await tx.ticket.update({ where: { id }, data: { ...body, ...(body.status ? { closedAt: body.status === 'CLOSED' ? new Date() : null } : {}) } });
    });
    await logActivity(req, user.id, 'ticket.status', `${id} ${JSON.stringify(body)}`);
    return { ok: true };
  });
  if (admin) app.delete('/:id', async (req) => {
    const user = requireUser(req); const { id } = parse(idParam, req.params);
    await load(id, user.id);
    const files = await prisma.$transaction(async (tx) => {
      const record = await tx.ticket.update({ where: { id }, data: { updatedAt: new Date() }, include: { attachments: { select: { storageKey: true } } } });
      await tx.ticket.delete({ where: { id } });
      return record.attachments;
    });
    await Promise.all(files.map((file) => removeTicketFile(file.storageKey).catch((err) => app.log.error({ err, storageKey: file.storageKey }, 'attachment deletion failed'))));
    await logActivity(req, user.id, 'ticket.delete', String(id));
    return { ok: true };
  });
  app.get('/:id/attachments/:attachmentId', async (req, reply) => {
    const user = requireUser(req);
    const { id, attachmentId } = parse(idParam.extend({ attachmentId: z.coerce.number().int().positive() }), req.params);
    const { download } = parse(z.object({ download: z.enum(['1']).optional() }), req.query);
    const attachment = ensureFound(await prisma.ticketAttachment.findFirst({ where: { id: attachmentId, ticketId: id, ...(admin ? {} : { ticket: { userId: user.id } }) } }), t('ticket.fileMissing'));
    const inline = !download && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mimeType);
    const stream = await openTicketFile(attachment.storageKey);
    return reply.type(attachment.mimeType).header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`)
      .header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox").header('cache-control', 'private, no-store').send(stream);
  });
}
