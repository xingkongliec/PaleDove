import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { MarketListingDTO } from '../../shared/index';
import { Button, LinkButton } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { daysLeftText, formatCores, formatDate, formatMemory, formatMoney } from '@/lib/format';
import { useCurrency, useMe, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';

function Line({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line/70 py-2 text-[13px] first:border-0">
      <span className="text-fg-3">{label}</span>
      <span className={strong ? 'tabular text-[15px] font-semibold text-fg' : 'tabular text-right text-fg'}>{children}</span>
    </div>
  );
}

/** 购买确认：显示商品、价格与余额；未登录时引导登录 / 注册 */
export function BuyDialog({ listing: l, onClose }: { listing: MarketListingDTO | null; onClose: () => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const { data: me } = useMe();
  const { data: cfg } = usePublicConfig();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const buy = useMutation({
    mutationFn: () => api.post<{ instanceId: number }>(`/market/listings/${l!.id}/buy`),
    onSuccess: (r) => {
      toast.success(t('market.bought'), t('market.boughtDesc'));
      void qc.invalidateQueries();
      onClose();
      navigate(`/console/instances/${r.instanceId}`);
    },
    onError: (e) => setError(errorText(e)),
  });
  const isUser = me?.role === 'USER';
  const balance = Number(me?.balance ?? 0);
  const price = Number(l?.price ?? 0);
  const short = isUser && balance < price;
  const redirect = encodeURIComponent('/market');
  const allowRegister = cfg?.allowRegister ?? true;

  const footer = !me ? (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <LinkButton to={`/login?redirect=${redirect}`} variant="secondary">
        {t('login.signIn')}
      </LinkButton>
      <LinkButton to={`${allowRegister ? '/register' : '/login'}?redirect=${redirect}`} variant="primary">
        {t('lp.signUp')}
      </LinkButton>
    </>
  ) : short ? (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <LinkButton to="/console/billing?topup=1" variant="primary">
        {t('shell.topUp')}
      </LinkButton>
    </>
  ) : (
    <>
      {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" loading={buy.isPending} disabled={!isUser} onClick={() => buy.mutate()}>
        {t('market.confirmBuy', { price: formatMoney(l?.price ?? 0, currency) })}
      </Button>
    </>
  );

  return (
    <Modal
      open={!!l}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
      title={t('market.buyTitle', { plan: l?.plan ?? l?.product?.name ?? '' })}
      description={t('market.buyDesc')}
      footer={footer}
    >
      {l && (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-1">
            <Line label={t('common.region')}>{l.region}</Line>
            <Line label={t('market.field.config')}>
              {formatCores(l.cpu)} {formatMemory(l.memory)} {l.disk}GB
            </Line>
            <Line label={t('market.field.renew')}>
              {formatMoney(l.renewPrice, currency)}/{L.billingCycle[l.billingCycle]}
            </Line>
            <Line label={t('market.field.expires')}>
              {formatDate(l.expiresAt, 'YYYY-MM-DD')} ({daysLeftText(l.expiresAt)})
            </Line>
            <Line label={t('market.field.handover')}>{t('market.mode.REINSTALL')}</Line>
            <Line label={t('market.price')} strong>
              {formatMoney(l.price, currency)}
            </Line>
            {isUser && <Line label={t('market.balanceAfter')}>{short ? <span className="text-danger-text">{formatMoney(balance, currency)}</span> : formatMoney(balance - price, currency)}</Line>}
          </div>
          <Alert tone="warning">{t('market.notice.reinstall')}</Alert>
          {!me && <p className="text-[13px] text-fg-3">{t('market.loginToBuy')}</p>}
          {short && <Alert tone="danger">{t('market.insufficient', { balance: formatMoney(balance, currency), price: formatMoney(price, currency) })}</Alert>}
          {me && !isUser && <Alert tone="warning">{t('market.adminCannotBuy')}</Alert>}
        </div>
      )}
    </Modal>
  );
}
