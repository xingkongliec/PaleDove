import type { AdminInvoiceDTO, AdminInvoicesDTO, InvoiceDTO, InvoiceStatus, InvoiceType, Paginated } from '../shared/index';
import { api } from './api';
import { dayjs } from './format';

export interface InvoiceFilters {
  q: string;
  type: InvoiceType | 'ALL';
  startDate: string;
  endDate: string;
}

export const emptyInvoiceFilters: InvoiceFilters = { q: '', type: 'ALL', startDate: '', endDate: '' };

export function invoiceListOptions(filters = emptyInvoiceFilters, page = 1, pageSize = 20) {
  return {
    queryKey: ['invoices', filters, page, pageSize],
    queryFn: () => api.get<Paginated<InvoiceDTO>>('/invoices', {
      q: filters.q || undefined,
      type: filters.type === 'ALL' ? undefined : filters.type,
      // 使用本地日期边界，结束日期包含当天全部账单。
      startAt: filters.startDate ? dayjs(filters.startDate).startOf('day').toISOString() : undefined,
      endAt: filters.endDate ? dayjs(filters.endDate).add(1, 'day').startOf('day').toISOString() : undefined,
      page,
      pageSize,
    }),
  };
}

export function invoiceDetailOptions(id: number) {
  return { queryKey: ['invoice', id], queryFn: () => api.get<InvoiceDTO>(`/invoices/${id}`) };
}

export function adminInvoiceListOptions(filters: InvoiceFilters & { status: InvoiceStatus | 'ALL' }, page = 1) {
  return {
    queryKey: ['admin-invoices', filters, page],
    queryFn: () => api.get<AdminInvoicesDTO>('/admin/billing/invoices', {
      q: filters.q || undefined,
      status: filters.status === 'ALL' ? undefined : filters.status,
      type: filters.type === 'ALL' ? undefined : filters.type,
      startAt: filters.startDate ? dayjs(filters.startDate).startOf('day').toISOString() : undefined,
      endAt: filters.endDate ? dayjs(filters.endDate).add(1, 'day').startOf('day').toISOString() : undefined,
      page, pageSize: 20,
    }),
  };
}

export function adminInvoiceDetailOptions(id: number) {
  return { queryKey: ['admin-invoice', id], queryFn: () => api.get<AdminInvoiceDTO>(`/admin/billing/invoices/${id}`) };
}
