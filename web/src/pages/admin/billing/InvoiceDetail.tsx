import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';
import { InvoiceLoading, InvoiceView } from '@/components/billing/InvoiceView';
import { Empty, ErrorState } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { adminInvoiceDetailOptions } from '@/lib/invoice-query';

export default function AdminInvoiceDetail() {
  const { t } = useI18n();
  const { id } = useParams();
  const [params] = useSearchParams();
  const invoiceId = Number(id);
  const query = useQuery({ ...adminInvoiceDetailOptions(invoiceId), enabled: Number.isInteger(invoiceId) && invoiceId > 0 });
  if (query.isLoading) return <InvoiceLoading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const invoice = query.data;
  if (!invoice) return <Empty icon={<FileText />} title={t('invoice.notFound')} />;
  const back = new URLSearchParams(params);
  back.set('tab', 'invoices');
  return <InvoiceView invoice={invoice} customer={invoice.user} backTo={`/admin/billing?${back}`} instanceLink={invoice.instanceId ? `/admin/instances/${invoice.instanceId}` : undefined} />;
}
