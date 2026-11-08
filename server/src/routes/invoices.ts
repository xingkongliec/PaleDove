import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INVOICE_STATUSES, INVOICE_TYPES, type InvoiceDTO } from '../shared/index.ts';
import { consoleGuard, idParam, logActivity, pageQuery, parse, requireUser } from '../lib/http.ts';
import { invoiceDto, listInvoices, payInvoice, cancelInvoice, getInvoiceDetail } from '../services/invoices.ts';
import { m } from '../i18n/index.ts';

export default async function invoiceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);

  app.get('/api/invoices', async (req): Promise<{ items: InvoiceDTO[]; total: number; page: number; pageSize: number }> => {
    const user = requireUser(req);
    const q = parse(pageQuery.extend({
      status: z.enum(INVOICE_STATUSES).optional(),
      type: z.enum(INVOICE_TYPES).optional(),
      q: z.string().trim().max(100).optional(),
      startAt: z.iso.datetime({ offset: true }).optional(),
      endAt: z.iso.datetime({ offset: true }).optional(),
    }).refine((v) => !v.startAt || !v.endAt || new Date(v.startAt) < new Date(v.endAt), { path: ['endAt'], message: m('invoice.invalidDateRange') }), req.query);
    const result = await listInvoices(user.id, q);
    return { items: result.items.map(invoiceDto), total: result.total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/invoices/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return getInvoiceDetail(id, user.id);
  });

  app.post('/api/invoices/:id/pay', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await payInvoice(id, user.id);
    await logActivity(req, user.id, 'billing.invoice_pay', row.no);
    return getInvoiceDetail(id, user.id);
  });

  app.post('/api/invoices/:id/cancel', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await cancelInvoice(id, user.id);
    await logActivity(req, user.id, 'billing.invoice_cancel', row.no);
    return getInvoiceDetail(id, user.id);
  });
}
