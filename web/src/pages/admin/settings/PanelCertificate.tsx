import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw, ShieldCheck } from 'lucide-react';
import type { PanelCertificateDTO, PanelCertificateStatusDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, CardBody, CardHeader, CopyButton, ErrorState, InfoList, Skeleton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { downloadText } from '@/lib/download';
import { formatDate } from '@/lib/format';

export function usePanelCertificate() {
  return useQuery({ queryKey: ['panel-cert'], queryFn: () => api.get<PanelCertificateStatusDTO>('/admin/certificate'), staleTime: 0 });
}

/** 仅下载用于宿主机信任的公钥证书，私钥始终留在服务端文件目录。 */
export function downloadPanelCertificate(cert: PanelCertificateDTO) {
  downloadText('paledove.crt', cert.certificate.replace(/\r\n/g, '\n').trim() + '\n', 'application/x-x509-ca-cert');
}

export function CertificateDownloadButton({ cert, variant = 'secondary' }: { cert: PanelCertificateDTO | undefined; variant?: 'primary' | 'secondary' }) {
  const { t } = useI18n();
  return (
    <Button variant={variant} icon={<Download />} disabled={!cert} onClick={() => cert && downloadPanelCertificate(cert)}>
      {t('nodes.certDownload')}
    </Button>
  );
}

/** 只展示本地证书状态；部署与备份由开发者在服务器侧完成。 */
export function PanelCertificateCard() {
  const { t } = useI18n();
  const q = usePanelCertificate();
  const status = q.data;
  const c = q.isError ? null : status?.certificate;
  return (
    <Card>
      <CardHeader title={t('nodes.certTitle')} icon={<ShieldCheck />} actions={
        <>
          <Button icon={<RefreshCw />} loading={q.isFetching} onClick={() => void q.refetch()}>{t('nodes.certReload')}</Button>
          <CertificateDownloadButton cert={c ?? undefined} />
        </>
      } />
      <CardBody className="space-y-4">
        <p className="text-[13px] text-fg-3">{t('nodes.certDesc')}</p>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !status ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <>
            <Badge dot tone={c ? 'success' : 'warning'}>{t(c ? 'nodes.certReady' : 'nodes.certNotReady')}</Badge>
            <InfoList items={[
              { label: t('nodes.certFilePath'), value: <span className="font-mono text-xs break-all">{status.certificatePath}</span> },
              { label: t('nodes.certKeyPath'), value: <span className="font-mono text-xs break-all">{status.privateKeyPath}</span> },
            ]} />
            {status.error && <Alert tone="warning" className="break-words">{status.error}</Alert>}
            {c ? (
              <InfoList items={[
                {
                  label: t('nodes.certFingerprint'),
                  value: <span className="flex items-start gap-1.5"><span className="font-mono text-xs break-all text-fg">{c.fingerprint}</span><CopyButton value={c.fingerprint} className="-mt-1 shrink-0" /></span>,
                },
                { label: t('nodes.certShort'), value: <span className="font-mono text-xs">{c.fingerprint.slice(0, 12)}</span> },
                { label: t('nodes.certSubject'), value: <span className="font-mono text-xs">{c.subject}</span> },
                { label: t('nodes.certKey'), value: c.keyAlgorithm },
                { label: t('nodes.certValidity'), value: t('nodes.certValidityValue', { from: formatDate(c.validFrom, 'YYYY-MM-DD'), to: formatDate(c.validTo, 'YYYY-MM-DD') }) },
              ]} />
            ) : <p className="text-[13px] leading-relaxed text-fg-3">{t('nodes.certSetupHint')}</p>}
          </>
        )}
        <p className="text-xs leading-relaxed text-fg-3">{t('nodes.certRotateHint')}</p>
      </CardBody>
      <div className="border-t border-line px-4 py-3 sm:px-5">
        <p className="text-xs leading-relaxed text-fg-4">{t('nodes.certPrivateNote')}</p>
      </div>
    </Card>
  );
}
