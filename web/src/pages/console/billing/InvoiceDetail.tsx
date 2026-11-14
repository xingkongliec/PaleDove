import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FileText, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import type { InvoiceDTO } from '@/shared/index';
import { InvoiceLoading, InvoiceView } from '@/components/billing/InvoiceView';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';
import { invoiceDetailOptions } from '@/lib/invoice-query';

export default function InvoiceDetail() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const invoiceId = Number(id);
  const query = useQuery({ ...invoiceDetailOptions(invoiceId), enabled: Number.isInteger(invoiceId) && invoiceId > 0 });
  const pay = useMutation({
    mutationFn: () => api.post<InvoiceDTO>(`/invoices/${invoiceId}/pay`),
    onSuccess: (data) => {
      qc.setQueryData(['invoice', invoiceId], data);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['instances'] });
      void qc.invalidateQueries({ queryKey: ['night-market'] });
      void qc.invalidateQueries({ queryKey: ['night-offer'] });
      void qc.invalidateQueries({ queryKey: ['invoice'] });
      if (data.status === 'PAID') {
        toast.success(t('invoice.paySuccess'));
        navigate('/console/instances');
      }
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<InvoiceDTO>(`/invoices/${invoiceId}/cancel`),
    onSuccess: (data) => { toast.success(t('invoice.cancelSuccess')); qc.setQueryData(['invoice', invoiceId], data); void qc.invalidateQueries({ queryKey: ['invoices'] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (query.isLoading) return <InvoiceLoading />;
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const invoice = query.data;
  if (!invoice) return <Empty icon={<FileText />} title={t('invoice.notFound')} />;
  const pending = invoice.status === 'PENDING';
  return <InvoiceView invoice={invoice} backTo="/console/invoices" actions={pending && <>
    <Button variant="ghost" icon={<X />} onClick={() => cancel.mutate()} loading={cancel.isPending} disabled={pay.isPending}>{t('invoice.cancel')}</Button>
    <Button variant="primary" icon={<CreditCard />} onClick={() => pay.mutate()} loading={pay.isPending} disabled={cancel.isPending}>{t('invoice.pay')}</Button>
  </>} />;
}
