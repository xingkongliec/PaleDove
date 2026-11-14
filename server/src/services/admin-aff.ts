import type { AdminAffLogDTO, AffLogStatus, AffLogType, Paginated } from '../shared/index.ts';
import { containsInsensitive, isSqlite, prisma, Prisma } from '../lib/prisma.ts';
import { paging } from '../lib/http.ts';
import { money } from './serializers.ts';

interface AdminAffFilters {
  page: number;
  pageSize: number;
  q?: string;
  type?: AffLogType;
  status?: AffLogStatus;
  startAt?: string;
  endAt?: string;
}

/** 只读取已存储的流水，查看明细不触发佣金结算或生成推广码。 */
export async function adminAffLogs(filters: AdminAffFilters): Promise<Paginated<AdminAffLogDTO>> {
  const { q, type, status, startAt, endAt } = filters;
  const where: Prisma.AffLogWhereInput = {
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(q ? { OR: [
      { user: { username: containsInsensitive(q) } },
      { user: { email: containsInsensitive(q) } },
      { invitee: { username: containsInsensitive(q) } },
      { invitee: { email: containsInsensitive(q) } },
      { order: { no: containsInsensitive(q) } },
    ] } : {}),
    ...((startAt || endAt) ? { createdAt: { ...(startAt ? { gte: new Date(startAt) } : {}), ...(endAt ? { lt: new Date(endAt) } : {}) } } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.affLog.findMany({
      where,
      include: {
        user: { select: { id: true, username: true } },
        invitee: { select: { id: true, username: true } },
        order: { select: { id: true, no: true, type: true, amount: true, status: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...paging(filters),
    }),
    prisma.affLog.count({ where }),
  ], { isolationLevel: isSqlite ? Prisma.TransactionIsolationLevel.Serializable : Prisma.TransactionIsolationLevel.RepeatableRead });
  return {
    items: rows.map(row => ({
      id: row.id,
      type: row.type,
      status: row.status,
      user: row.user,
      invitee: row.invitee,
      order: row.order ? { ...row.order, amount: money(row.order.amount) } : null,
      amount: money(row.amount),
      balanceAfter: row.status === 'SETTLED' ? money(row.balanceAfter) : null,
      orderAmount: row.orderAmount === null ? null : money(row.orderAmount),
      rate: row.rate?.toString() ?? null,
      createdAt: row.createdAt.toISOString(),
      effectiveAt: row.effectiveAt?.toISOString() ?? null,
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}
