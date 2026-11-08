// 提交工单：标题、分类、优先级、相关实例、问题描述与附件；右侧为优先级说明与描述建议
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SendHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { TICKET_PRIORITIES, type InstanceDTO, type TicketDTO } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert, Card, CardBody } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { categoryOptions, DropZone, PriorityBadge, priorityOptions } from './parts';

const SUBJECT_MAX = 120;
const CONTENT_MAX = 20000;

/** 右侧说明：优先级含义与描述问题的建议 */
function Guide() {
  const t = useT();
  return (
    <Card>
      <CardBody className="space-y-5">
        <section>
          <h3 className="text-[13px] font-semibold text-fg">{t('ticket.priorityHelp')}</h3>
          <ul className="mt-3 space-y-2.5">
            {[...TICKET_PRIORITIES].reverse().map((value) => (
              <li key={value} className="flex items-center gap-3 text-[13px]">
                <span className="w-12 shrink-0">
                  <PriorityBadge value={value} />
                </span>
                <span className="text-fg-3">{t(`ticket.priorityDesc.${value}`)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="border-t border-line pt-4">
          <h3 className="text-[13px] font-semibold text-fg">{t('ticket.descriptionHelp')}</h3>
          <ol className="mt-3 space-y-2 text-[13px] leading-relaxed text-fg-3">
            {(['ticket.help1', 'ticket.help2', 'ticket.help3', 'ticket.help4'] as const).map((key, i) => (
              <li key={key} className="flex gap-2.5">
                <span className="tabular flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-medium text-fg-2">{i + 1}</span>
                {t(key)}
              </li>
            ))}
          </ol>
        </section>
      </CardBody>
    </Card>
  );
}

export function TicketCreate() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: site } = usePublicConfig();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [resourceRef, setResourceRef] = useState('');
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const instances = useQuery({ queryKey: ['ticket-resources'], queryFn: () => api.get<InstanceDTO[]>('/instances'), enabled: !!site?.allowTickets });
  const create = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('subject', subject.trim());
      form.append('category', category);
      form.append('priority', priority);
      form.append('content', content.trim());
      if (resourceRef) form.append('resourceRef', resourceRef);
      files.forEach((file) => form.append('files', file));
      return api.post<TicketDTO>('/tickets', form);
    },
    onSuccess: (ticket) => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      toast.success(t('ticket.created'));
      navigate(`/tickets/${ticket.id}`);
    },
    onError: (error) => toast.fromError(error),
  });
  const valid = !!site?.allowTickets && subject.trim().length >= 2 && !!category && !!content.trim();
  const busy = create.isPending;

  return (
    <div>
      <PageHeader title={t('ticket.new')} description={t('ticket.createDesc')} back={{ to: '/tickets', label: t('ticket.back') }} />
      {site?.allowTickets === false ? (
        <Alert>{t('ticket.disabled')}</Alert>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (valid && !busy) create.mutate();
              }}
            >
              <fieldset disabled={busy} className="space-y-4 p-4 sm:p-5">
                <FormField label={t('ticket.subject')} required description={`${subject.length}/${SUBJECT_MAX}`}>
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={2} maxLength={SUBJECT_MAX} placeholder={t('ticket.subjectPlaceholder')} autoFocus />
                </FormField>
                <div className="grid gap-4 sm:grid-cols-3">
                  <FormField label={t('ticket.category')} required>
                    <Select value={category} onChange={setCategory} options={categoryOptions(t)} placeholder={t('ticket.categoryPlaceholder')} aria-label={t('ticket.category')} disabled={busy} />
                  </FormField>
                  <FormField label={t('ticket.priority')} required>
                    <Select value={priority} onChange={setPriority} options={priorityOptions(t)} aria-label={t('ticket.priority')} disabled={busy} />
                  </FormField>
                  <FormField label={t('ticket.resource')} description={t('ticket.optional')}>
                    <Select
                      value={resourceRef}
                      onChange={setResourceRef}
                      options={[
                        { value: '', label: t('ticket.noResource') },
                        ...(instances.data ?? []).filter((i) => i.status !== 'DELETING').map((i) => ({ value: String(i.id), label: i.hostname, description: i.region })),
                      ]}
                      aria-label={t('ticket.resource')}
                      disabled={busy}
                    />
                  </FormField>
                </div>
                {instances.error && (
                  <Alert tone="warning">
                    {instances.error.message}
                    <Button size="sm" variant="ghost" onClick={() => void instances.refetch()}>
                      {t('common.retry')}
                    </Button>
                  </Alert>
                )}
                <FormField label={t('ticket.content')} required description={`${content.length}/${CONTENT_MAX}`}>
                  <Textarea aria-label={t('ticket.content')} rows={10} maxLength={CONTENT_MAX} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('ticket.descriptionPlaceholder')} required />
                </FormField>
                <FormField label={t('ticket.attachments')}>
                  <DropZone files={files} setFiles={setFiles} disabled={busy} />
                </FormField>
              </fieldset>
              <div className="flex justify-end gap-2 border-t border-line bg-surface-2/40 px-4 py-3 sm:px-5">
                <LinkButton to="/tickets">{t('ticket.cancel')}</LinkButton>
                <Button type="submit" variant="primary" icon={<SendHorizontal />} loading={busy} disabled={!valid}>
                  {t('ticket.new')}
                </Button>
              </div>
            </form>
          </Card>
          <aside className="xl:sticky xl:top-4">
            <Guide />
          </aside>
        </div>
      )}
    </div>
  );
}
