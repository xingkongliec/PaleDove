import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useTransition } from 'react';
import { useNavigate } from 'react-router';
import type { InvoiceDTO } from '../shared/index';
import { useT } from '@/i18n';
import { beginLoading } from '@/lib/loading';
import { loaders, preload } from '@/lib/routes';
import { toast } from '@/lib/toast';

/** 三类消费共用提交反馈、账单缓存与详情跳转，成功后按钮保持锁定直到切页完成。 */
export function useCreateInvoice<T = void>({
  mutationFn,
  onError,
  onCreated,
}: {
  mutationFn: (variables: T) => Promise<{ invoice: InvoiceDTO }>;
  onError: (error: Error) => void;
  onCreated?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [opening, startNavigation] = useTransition();
  const mutation = useMutation({
    mutationFn,
    meta: { progress: true },
    onMutate: () => preload(loaders.invoiceDetail),
    onSuccess: ({ invoice }) => {
      qc.setQueryData(['invoice', invoice.id], invoice);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      onCreated?.();
      toast.success(t('invoice.created'), invoice.no);
      startNavigation(() => navigate(`/console/invoices/${invoice.id}`));
    },
    onError,
  });
  useEffect(() => {
    if (opening) return beginLoading();
  }, [opening]);

  return { ...mutation, isPending: mutation.isPending || opening, loadingText: t(opening ? 'invoice.opening' : 'invoice.creating') };
}
