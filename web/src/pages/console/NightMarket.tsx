import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronDown, Clock3, Cpu, Diamond, HardDrive, LockKeyhole, MemoryStick, MoonStar, Repeat2, ShieldCheck, ShoppingBag, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import type { NightMarketDTO, NightOfferDTO } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { Alert, Badge, ErrorState, Skeleton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatCores, formatDate, formatMemory, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import './NightMarket.css';

function NightCard({ offer, open }: { offer: NightOfferDTO; open: boolean }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const [flippedNow, setFlippedNow] = useState(false);
  const reveal = useMutation({
    mutationFn: () => api.post<NightOfferDTO>(`/night-market/offers/${offer.id}/reveal`),
    onSuccess: updated => {
      setFlippedNow(true);
      qc.setQueryData<NightMarketDTO>(['night-market'], current => current ? { ...current, offers: current.offers.map(item => item.id === updated.id ? updated : item) } : current);
    },
    onError: error => { toast.fromError(error); void qc.invalidateQueries({ queryKey: ['night-market'] }); },
  });
  const prize = offer.prize;
  const quality = t(`night.quality.${offer.quality}`);
  const revealed = !!offer.revealedAt;
  return <article className={`night-card night-quality-${offer.quality}${revealed ? ' is-revealed' : ''}${flippedNow ? ' just-flipped' : ''}${offer.purchasedAt ? ' is-purchased' : ''}`} style={{ '--card-index': offer.position } as CSSProperties}>
    <div className="night-card-rotor">
      <button type="button" className="night-card-back" disabled={!open || revealed || reveal.isPending} aria-hidden={revealed} inert={revealed} aria-busy={reveal.isPending} aria-label={t('night.revealLabel', { n: offer.position + 1, quality })} onClick={() => reveal.mutate()}>
        <span className="night-card-top"><span className="night-card-number">0{offer.position + 1}</span><LockKeyhole className="size-3.5 text-fg-4" aria-hidden /></span>
        <span className="night-card-mystery">
          <span className="night-card-sigil" aria-hidden><Diamond /><Sparkles /></span>
          <span className="night-card-quality"><span className="night-quality-dot" />{quality}</span>
          <span className="night-card-secret">{t('night.exclusiveOffer')}</span>
          <span className="night-card-secret-hint">{t('night.revealHint')}</span>
        </span>
        <span className="night-card-prompt"><span>{t(reveal.isPending ? 'night.revealing' : open ? 'night.reveal' : 'night.expired')}</span>{open && <ArrowRight className="size-3.5" aria-hidden />}</span>
      </button>
      {prize && <div className="night-card-front" inert={!revealed} aria-hidden={!revealed}>
        <div className="night-card-top"><span className="night-card-quality"><span className="night-quality-dot" />{quality}</span><span className="night-card-number">0{offer.position + 1}</span></div>
        <div className="night-card-product"><span title={prize.productName}>{prize.productName}</span><h3 title={prize.name}>{prize.name}</h3><p title={prize.description || prize.planName}>{prize.description || prize.planName}</p></div>
        <span className="night-discount"><Sparkles className="size-3.5" aria-hidden />{t('night.savePercent', { percent: offer.discountPercent! })}</span>
        <dl className="night-card-spec">
          <div><dt><Cpu aria-hidden /><span>{t('night.spec.cpu')}</span></dt><dd>{formatCores(prize.cpu)}</dd></div>
          <div><dt><MemoryStick aria-hidden /><span>{t('spec.memory')}</span></dt><dd>{formatMemory(prize.memory)}</dd></div>
          <div><dt><HardDrive aria-hidden /><span>{t('spec.disk')}</span></dt><dd>{prize.disk} GB</dd></div>
        </dl>
        <div className="night-card-price">
          <div className="night-card-price-meta"><del aria-label={t('night.originalPrice')}>{formatMoney(prize.originalPrice, currency)}</del><span title={t(`night.modeHint.${prize.discountMode}`)}>{prize.discountMode === 'RECURRING' && <Repeat2 aria-hidden />}{t(`night.mode.${prize.discountMode}`)}</span></div>
          <div className="night-card-price-amount"><strong>{formatMoney(offer.amount!, currency)}</strong><span>/{L.billingCycle[prize.cycle]}</span></div>
        </div>
        <div className="night-card-action">
          {offer.purchasedAt ? offer.instanceId ? <Link to={`/console/instances/${offer.instanceId}`} className={buttonClass('ghost', 'md', 'w-full')}><Check />{t('night.viewInstance')}</Link> : <span className="night-card-complete"><Check className="size-4" />{t('night.purchased')}</span>
            : open ? <Link className={buttonClass('primary', 'md', 'w-full active:scale-[0.98]')} to={offer.invoiceId ? `/console/invoices/${offer.invoiceId}` : `/console/store?plan=${prize.planId}&cycle=${prize.cycle}&nightOffer=${offer.id}`}>{t(offer.invoiceId ? 'night.payInvoice' : 'night.buy')}<ArrowRight /></Link>
            : <Button disabled className="w-full">{t('night.expired')}</Button>}
        </div>
      </div>}
    </div>
  </article>;
}

function NightMarketLoading() {
  const { t } = useI18n();
  return <div className="night-market-page" aria-busy="true" aria-label={t('common.loading')}>
    <PageHeader title={t('night.title')} description={t('night.subtitle')} />
    <div className="night-market-overview"><div className="space-y-3"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-64 max-w-full" /><Skeleton className="h-2 w-40" /></div><Skeleton className="h-14 w-52 max-w-full" /></div>
    <div className="night-market-grid">{Array.from({ length: 6 }, (_, index) => <div key={index} className="night-card-skeleton"><Skeleton className="h-3 w-12" /><Skeleton className="mx-auto my-16 size-14 rounded-full" /><Skeleton className="mt-auto h-8 w-full" /></div>)}</div>
  </div>;
}

export default function NightMarket() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['night-market'], queryFn: () => api.get<NightMarketDTO>('/night-market'), staleTime: 0, refetchInterval: 30_000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const data = query.data;
  const offset = useMemo(() => data ? new Date(data.serverTime).getTime() - Date.now() : 0, [data?.serverTime]);
  const boundary = data?.state === 'open' ? data.period?.closesAt : data?.nextStartsAt;
  useEffect(() => {
    if (!boundary || !data) return;
    const delay = new Date(boundary).getTime() - new Date(data.serverTime).getTime();
    const timer = window.setTimeout(() => void query.refetch(), Math.min(Math.max(1000, delay + 100), 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [boundary, data?.serverTime]); // Each server response resets the timer using server time.
  if (!data && query.isLoading) return <NightMarketLoading />;
  if (!data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const left = Math.max(0, Math.ceil(((boundary ? new Date(boundary).getTime() : now) - now - offset) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const countdown = t('night.timeLeft', { days: Math.floor(left / 86400), hours: pad(Math.floor(left % 86400 / 3600)), minutes: pad(Math.floor(left % 3600 / 60)), seconds: pad(left % 60) });
  const open = data.state === 'open' && left > 0;
  const status = data.state === 'open' ? 'closed' : data.state;
  const revealedCount = data.offers.filter(card => card.revealedAt).length;
  const hasOffers = data.offers.length > 0;
  const units = [{ key: 'days', value: pad(Math.floor(left / 86400)) }, { key: 'hours', value: pad(Math.floor(left % 86400 / 3600)) }, { key: 'minutes', value: pad(Math.floor(left % 3600 / 60)) }, { key: 'seconds', value: pad(left % 60) }] as const;
  return <div className="night-market-page">
    <PageHeader title={t('night.title')} description={t('night.subtitle')} meta={data.period && <Badge>{t('night.period', { id: data.period.number })}</Badge>} actions={<Badge dot tone={open ? 'success' : 'neutral'}>{t(open ? 'night.openNow' : `night.state.${status}`)}</Badge>} />
    <section className="night-market-overview" aria-label={t('night.yourOffers')}>
      <div className="night-market-intro">
        <span className="night-market-icon"><MoonStar aria-hidden /></span>
        <div className="min-w-0"><h2>{t(open ? 'night.yourOffers' : `night.state.${status}`)}</h2><p>{t(open ? 'night.personalHint' : `night.state.${status}Hint`)}</p>
          {hasOffers && <div className="night-market-progress"><div className="night-market-progress-track" role="progressbar" aria-label={t('night.revealProgress')} aria-valuemin={0} aria-valuemax={6} aria-valuenow={revealedCount}>{data.offers.map(offer => <span key={offer.id} data-revealed={!!offer.revealedAt} />)}</div><span>{t('night.revealed', { count: revealedCount })}</span></div>}
        </div>
      </div>
      {boundary && <div className="night-market-countdown">
        <span className="night-market-countdown-label"><Clock3 aria-hidden />{t(open ? 'night.endsIn' : 'night.startsIn')}</span>
        <dl aria-label={countdown}>{units.map(unit => <div key={unit.key}><dt>{t(`night.unit.${unit.key}`)}</dt><dd>{unit.value}</dd></div>)}</dl>
        <time dateTime={boundary}>{formatDate(boundary)}</time>
      </div>}
    </section>
    <section className="night-market-offers" aria-label={t('night.yourOffers')}>
      {hasOffers ? <>
        <div className="night-market-section-title"><h2>{t('night.periodOffers')}</h2><span><LockKeyhole aria-hidden />{t('night.fixedHint')}</span></div>
        <div className="night-market-grid">{data.offers.map(offer => <NightCard key={offer.id} offer={offer} open={open} />)}</div>
      </> : <div className="night-market-waiting"><span className="night-market-icon"><MoonStar aria-hidden /></span><h2>{t(`night.state.${status}`)}</h2><p>{t(`night.state.${status}Hint`)}</p></div>}
    </section>
    <details className="night-market-rules">
      <summary><span className="night-market-rule-highlights"><span><Diamond aria-hidden />{t('night.rule.six')}</span>{data.period?.drawRules?.guaranteeEnabled && <span><ShieldCheck aria-hidden />{t('night.rule.guarantee', { count: data.period.drawRules.guaranteeCount, quality: t(`night.quality.${data.period.drawRules.guaranteeQuality}`) })}</span>}<span><ShoppingBag aria-hidden />{t('night.rule.one')}</span></span><span className="night-market-rules-toggle">{t('night.rules')}<ChevronDown className="size-3.5" aria-hidden /></span></summary>
      <p>{t('night.ruleHint')}</p>
    </details>
    {query.error && <Alert tone="warning" className="mt-4">{errorText(query.error)}</Alert>}
  </div>;
}
