import type { SiteSettings } from '../shared/index.ts';
import { prisma, Prisma } from '../lib/prisma.ts';
import { changeBalance } from './billing.ts';
import { t } from '../i18n/index.ts';

/** 账号与赠送流水一起提交，注册重试或后续验证不会重复赠送。 */
export async function createRegisteredUser(data: Prisma.UserCreateInput, settings: SiteSettings, referrerId?: number | null) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: referrerId ? { ...data, referrer: { connect: { id: referrerId } } } : data });
    if (settings.signupBonus > 0) {
      await changeBalance(tx, user.id, new Prisma.Decimal(settings.signupBonus), 'ADJUST', t('auth.signupBonus'));
    }
    return tx.user.findUniqueOrThrow({ where: { id: user.id } });
  });
}
