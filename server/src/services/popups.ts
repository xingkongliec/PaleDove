import { randomUUID } from 'node:crypto';
import type { AdminPopupSettingsDTO, PopupNotice, PopupPromotion, PublicPopupsDTO } from '../shared/index.ts';
import { getSetting, setSetting } from '../lib/settings.ts';
import { prisma } from '../lib/prisma.ts';
import { badRequest } from '../lib/errors.ts';
import { t } from '../i18n/index.ts';
import { withLock } from '../lib/redis.ts';

const salePlan = (id: number) => prisma.plan.findFirst({ where: { id, enabled: true, product: { enabled: true } }, select: { id: true } });

export async function adminPopupSettings(): Promise<AdminPopupSettingsDTO> {
  const [settings, plans] = await Promise.all([
    getSetting('popups'),
    prisma.plan.findMany({ where: { enabled: true, product: { enabled: true } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, name: true, product: { select: { name: true } } } }),
  ]);
  return { ...settings, plans: plans.map(plan => ({ id: plan.id, name: plan.name, productName: plan.product?.name ?? '' })) };
}

export async function savePopupNotice(input: Omit<PopupNotice, 'revision'>): Promise<PopupNotice> {
  return withLock('settings:popups', 10_000, async () => {
    const { notice } = await getSetting('popups', true);
    const changed = notice.title !== input.title || notice.content !== input.content;
    const value = { ...input, enabled: input.enabled && !!input.content, revision: changed ? randomUUID() : notice.revision };
    await setSetting('popups', { notice: value });
    return value;
  });
}

export async function savePopupPromotion(input: Omit<PopupPromotion, 'revision'>): Promise<PopupPromotion> {
  if (input.enabled && !input.imageUrl) throw badRequest(t('popup.imageRequired'));
  if (input.enabled && input.planId !== null && !(await salePlan(input.planId))) throw badRequest(t('popup.planUnavailable'));
  return withLock('settings:popups', 10_000, async () => {
    const { promotion } = await getSetting('popups', true);
    const changed = promotion.title !== input.title || promotion.imageUrl !== input.imageUrl || promotion.planId !== input.planId;
    const value = { ...input, revision: changed ? randomUUID() : promotion.revision };
    await setSetting('popups', { promotion: value });
    return value;
  });
}

export async function publicPopups(): Promise<PublicPopupsDTO> {
  const { notice, promotion } = await getSetting('popups');
  const showPromotion = promotion.enabled && promotion.imageUrl && (!promotion.planId || await salePlan(promotion.planId));
  return { notice: notice.enabled && notice.content ? notice : null, promotion: showPromotion ? promotion : null };
}
