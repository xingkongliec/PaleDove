import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Pencil, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import type { AnnouncementDTO } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, Checkbox, Empty, Switch } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

function AnnouncementDialog({ item, onClose }: { item?: AnnouncementDTO; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState(item?.title ?? '');
  const [content, setContent] = useState(item?.content ?? '');
  const [pinned, setPinned] = useState(item?.pinned ?? false);
  const [published, setPublished] = useState(item?.published ?? true);
  const [announceEmail, setAnnounceEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { title, content, pinned, published, announceEmail: published && announceEmail };
      return item ? api.patch(`/admin/announcements/${item.id}`, body) : api.post('/admin/announcements', body);
    },
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['admin-announcements'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={item ? t('ann.edit') : t('ann.create')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('ann.title')} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label={t('common.content')} required>
          <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap gap-6">
          <Switch checked={published} onCheckedChange={setPublished} label={t('ann.publish')} />
          <Switch checked={pinned} onCheckedChange={setPinned} label={t('dash.pinned')} />
        </div>
        {published && <Checkbox checked={announceEmail} onCheckedChange={setAnnounceEmail} label={t('maintenance.email')} />}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export default function AdminAnnouncements() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AnnouncementDTO | 'new' | null>(null);
  const q = useQuery({ queryKey: ['admin-announcements'], queryFn: () => api.get<AnnouncementDTO[]>('/admin/announcements') });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/announcements/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-announcements'] }),
    onError: (e) => toast.fromError(e),
  });
  return (
    <>
      <PageHeader
        title={t('nav.admin.announcements')}
        description={t('ann.subtitle')}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
            {t('ann.create')}
          </Button>
        }
      />
      <Card>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(a) => a.id}
          empty={<Empty title={t('dash.noAnnouncements')} icon={<Megaphone />} />}
          columns={[
            {
              key: 'title',
              header: t('ann.title'),
              cell: (a) => (
                <div className="max-w-xl min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 font-medium text-fg">
                    {a.title}
                    {a.pinned && <Badge tone="primary">{t('dash.pinned')}</Badge>}
                    {!a.published && <Badge>{t('ann.draft')}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-fg-3">{a.content}</div>
                </div>
              ),
            },
            { key: 'time', header: t('common.updatedAt'), cell: (a) => <span className="text-xs">{formatDate(a.updatedAt)}</span> },
            {
              key: 'actions',
              header: '',
              className: 'w-24',
              cell: (a) => (
                <div className="flex justify-end gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setEditing(a)}>
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={t('common.delete')}
                    onClick={async () => {
                      if (await confirm({ title: t('ann.deleteTitle', { title: a.title }), danger: true })) remove.mutate(a.id);
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {editing && <AnnouncementDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
