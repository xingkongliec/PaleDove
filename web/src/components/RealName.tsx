// 用户实名认证：填写姓名和身份证号 → 支付宝扫码刷脸 → 轮询结果；购买页用 useRealName 判断是否已认证
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Clock, IdCard, ScanFace, ShieldAlert, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type ReactNode } from 'react';
import type { RealNameInfoDTO } from '../shared/index';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Card, CardBody, CardHeader } from '@/components/ui/misc';
import { useI18n, type TFunction } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

export function useRealName(enabled = true) {
  return useQuery({ queryKey: ['realname'], queryFn: () => api.get<RealNameInfoDTO>('/realname'), enabled });
}

/** 与服务端一致的身份证校验（提交前即时提示，服务端仍会再校验） */
function idError(raw: string, t: TFunction) {
  const id = raw.trim().toUpperCase();
  if (!id) return null;
  if (!/^\d{17}[\dX]$/.test(id)) return t('realname.idFormat');
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = w.reduce((s, x, i) => s + x * Number(id[i]), 0);
  if ('10X98765432'[sum % 11] !== id[17]) return t('realname.idChecksum');
  return null;
}

const STATUS: Record<RealNameInfoDTO['status'], { label: Parameters<TFunction>[0]; tone: string; icon: ReactNode }> = {
  NONE: { label: 'realname.status.none', tone: 'bg-surface-3 text-fg-2', icon: <IdCard className="size-5" /> },
  PENDING: { label: 'realname.status.pending', tone: 'bg-warning-soft text-warning-text', icon: <Clock className="size-5" /> },
  APPROVED: { label: 'realname.status.approved', tone: 'bg-success-soft text-success-text', icon: <BadgeCheck className="size-5" /> },
  REJECTED: { label: 'realname.status.rejected', tone: 'bg-danger-soft text-danger-text', icon: <ShieldAlert className="size-5" /> },
};

const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
/** 在手机上直接拉起支付宝打开认证页 */
const alipayScheme = (url: string) => `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(url)}`;

export function RealNameCard({ className }: { className?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data } = useRealName();
  const setData = (d: RealNameInfoDTO) => qc.setQueryData(['realname'], d);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState<'start' | 'check' | null>(null);
  // 认证中时可以重新填写（例如填错了信息）
  const [refill, setRefill] = useState(false);
  const [qr, setQr] = useState('');
  const url = data?.status === 'PENDING' ? data.certifyUrl : null;

  useEffect(() => {
    if (!url) return setQr('');
    QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' }).then(setQr, () => setQr(''));
  }, [url]);

  // 显示二维码期间每 3 秒查询一次结果（页面不可见时暂停）
  useEffect(() => {
    if (!url || refill) return;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await api.post<RealNameInfoDTO>('/realname/check');
        if (r.status !== 'PENDING' || !r.certifyUrl) {
          setData(r);
          if (r.status === 'APPROVED') toast.success(t('realname.approvedToast'));
        }
      } catch {
        // 网络抖动时下一轮再查
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [url, refill]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const st = STATUS[data.status];
  const showForm = data.available && (data.status === 'NONE' || data.status === 'REJECTED' || (data.status === 'PENDING' && (!url || refill)));
  const err = idError(id, t);

  const start = async () => {
    setBusy('start');
    try {
      const r = await api.post<RealNameInfoDTO>('/realname', { realName: name.trim(), idNumber: id.trim() });
      setData(r);
      setRefill(false);
      setName('');
      setId('');
      if (r.certifyUrl && isMobile()) window.location.href = alipayScheme(r.certifyUrl);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy('check');
    try {
      const r = await api.post<RealNameInfoDTO>('/realname/check');
      setData(r);
      if (r.status === 'APPROVED') toast.success(t('realname.approvedToast'));
      else if (r.status === 'PENDING') toast.info(t('realname.notYet'));
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader title={t('account.nav.realname')} />
      <CardBody>
        <div className="flex flex-wrap items-start gap-4">
          <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', st.tone)}>{st.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold">{t(st.label)}</span>
              {data.nameMasked && data.status !== 'REJECTED' && (
                <span className="text-[13px] text-fg-3" translate="no">
                  {data.nameMasked} · {data.idNumberMasked}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-fg-3">
              {data.status === 'APPROVED'
                ? t('realname.approvedAt', { time: formatDate(data.reviewedAt ?? data.submittedAt) })
                : data.status === 'PENDING' && url
                  ? t('realname.scanHint')
                  : t('realname.intro')}
            </p>
            {data.status === 'REJECTED' && data.reason && (
              <Alert tone="danger" className="mt-3">
                {t('realname.rejectedReason', { reason: data.reason })}
              </Alert>
            )}
          </div>
        </div>

        {!data.available && data.status !== 'APPROVED' && (
          <Alert tone="warning" className="mt-5">
            {t('realname.unavailable')}
          </Alert>
        )}

        {url && !refill && (
          <div className="mt-5 flex flex-col items-center gap-5 border-t border-line pt-5 sm:flex-row sm:items-start">
            {/* 二维码始终是白底，深色模式下也要保证能被扫描 */}
            <div className="shrink-0 rounded-xl border border-line bg-[#ffffff] p-2.5">
              {qr ? <img src={qr} alt={t('realname.qrAlt')} className="size-44" /> : <div className="skeleton fade-in-delay size-44 rounded-lg" />}
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <ol className="space-y-2 text-[13px]">
                {[t('realname.step1'), t('realname.step2'), t('realname.step3')].map((s, i) => (
                  <li key={s} className="flex gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-medium tabular-nums">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              <div className="flex items-center gap-1.5 text-xs text-fg-3">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-warning" />
                </span>
                {t('realname.waiting')}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="primary" icon={<ScanFace className="size-4" />} loading={busy === 'check'} onClick={check}>
                  {t('realname.done')}
                </Button>
                <a href={alipayScheme(url)} className="sm:hidden">
                  <Button icon={<Smartphone className="size-4" />}>{t('realname.openAlipay')}</Button>
                </a>
                <Button variant="ghost" onClick={() => setRefill(true)}>
                  {t('realname.refill')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {showForm && (
          <div className="mt-5 border-t border-line pt-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label={t('realname.realName')} required>
                <Input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder={t('realname.realNamePlaceholder')} autoComplete="name" />
              </FormField>
              <FormField label={t('realname.idNumber')} required description={err ? undefined : t('realname.idNumberHint')} error={err ?? undefined}>
                <Input className="font-mono" value={id} maxLength={18} onChange={(e) => setId(e.target.value.toUpperCase().replace(/[^0-9X]/g, ''))} placeholder="11010519491231002X" autoComplete="off" />
              </FormField>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-fg-3">{t('realname.nextStep')}</span>
              <div className="flex gap-2">
                {refill && <Button onClick={() => setRefill(false)}>{t('common.cancel')}</Button>}
                <Button variant="primary" icon={<ScanFace className="size-4" />} loading={busy === 'start'} disabled={!name.trim() || id.length !== 18 || !!err} onClick={start}>
                  {t('realname.start')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
