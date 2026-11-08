import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ExternalLink, Eye, EyeOff, FileText, FolderOpen, Pencil, Pin, Plus, RotateCcw, Trash } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import type { AdminDocumentsDTO, DocumentCategoryDTO, DocumentDTO } from '../../shared/index';
import { Markdown } from '@/components/Markdown';
import { PageHeader, Toolbar } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, CardBody, Checkbox, Empty, ErrorState, PageLoading, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';

type Tab = 'documents' | 'categories' | 'registration';
const MAX = 100_000;
const publicPath = (doc: DocumentDTO) => doc.kind ? `/${doc.kind}` : `/help/${doc.slug}`;

function useRefreshDocuments() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['admin-documents', 'public-documents', 'public-document', 'public-config', 'legal', 'legal-settings', 'announcements', 'admin-announcements']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
}

function DocumentEditor({ item, data, onClose }: { item?: DocumentDTO; data: AdminDocumentsDTO; onClose: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const refresh = useRefreshDocuments();
  const { data: site } = usePublicConfig();
  const [form, setForm] = useState({ title: item?.title ?? '', slug: item?.slug ?? '', content: item?.content ?? '', categoryId: item?.categoryId ?? 'general', order: item?.order ?? 0, published: item?.published ?? true, pinned: item?.pinned ?? false });
  const [preview, setPreview] = useState(false);
  const [announce, setAnnounce] = useState(false);
  const [email, setEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(current => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, announce: form.published && announce, announceEmail: form.published && announce && email };
      return item ? api.patch(`/admin/documents/${item.id}`, body) : api.post('/admin/documents', body);
    },
    onSuccess: () => { refresh(); toast.success(t('common.saved')); onClose(); },
    onError: err => setError(errorText(err)),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!save.isPending) save.mutate(); };
  const rendered = form.content.replaceAll('{{站点名称}}', site?.siteName ?? 'PaleDove').replaceAll('{{网址}}', location.origin);
  return (
    <Modal open size="2xl" title={t(item ? 'documents.edit' : 'documents.create')} onOpenChange={open => !open && !save.isPending && onClose()} footer={<>
      <Button disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</Button>
      <Button type="submit" form="document-editor" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
    </>}>
      <form id="document-editor" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('documents.docTitle')} required><Input required maxLength={120} value={form.title} onChange={e => set('title', e.target.value)} /></FormField>
          <FormField label={t('documents.slug')} required description={t(item?.kind ? 'documents.fixedSlug' : 'documents.slugHint')}>
            <Input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.slug} readOnly={!!item?.kind} placeholder="getting-started" onChange={e => set('slug', e.target.value)} />
          </FormField>
        </div>
        <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_140px_1fr]">
          <FormField label={t('documents.category')}><Select aria-label={t('documents.category')} value={form.categoryId} onChange={value => set('categoryId', value)} options={data.categories.map(category => ({ value: category.id, label: category.name }))} /></FormField>
          <FormField label={t('common.sortOrder')}><Input type="number" required min={-10000} max={10000} value={form.order} onChange={e => set('order', Number(e.target.value))} /></FormField>
          <div className="flex flex-wrap gap-5 pt-1 sm:col-span-2 lg:col-span-1 lg:pt-7">
            <Switch checked={form.published} disabled={!!item?.kind} onCheckedChange={value => set('published', value)} label={t('documents.published')} />
            <Switch checked={form.pinned} onCheckedChange={value => set('pinned', value)} label={t('dash.pinned')} />
          </div>
        </div>
        {item?.kind && <p className="text-xs text-fg-3">{t('documents.builtinHint')}</p>}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="document-content" className="text-[13px] font-medium text-fg-2">{t('documents.markdown')}</label>
            <div className="flex items-center gap-2">
              {item?.kind && <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={async () => {
                if (await confirm({ title: t('legal.restoreConfirm', { title: form.title }), description: t('legal.restoreHint'), confirmText: t('legal.restore') })) set('content', data.defaults[item.kind!]);
              }}>{t('legal.restore')}</Button>}
              <Button size="sm" variant={preview ? 'secondary' : 'ghost'} icon={<Eye />} onClick={() => setPreview(value => !value)} aria-pressed={preview}>{t('legal.preview')}</Button>
            </div>
          </div>
          <div className={preview ? 'grid gap-4 lg:grid-cols-2' : ''}>
            <Textarea id="document-content" required maxLength={MAX} value={form.content} onChange={e => set('content', e.target.value)} className="h-[38dvh] min-h-64 resize-y font-mono text-[13px] leading-6 sm:h-[42dvh]" spellCheck={false} translate="no" placeholder={t('documents.contentPlaceholder')} />
            {preview && <div className="order-first h-[38dvh] min-h-64 overflow-y-auto rounded-lg border border-line px-5 py-4 sm:h-[42dvh] lg:order-none" translate="no"><h2 className="mb-5 text-xl font-semibold">{form.title || t('documents.docTitle')}</h2>{rendered ? <Markdown source={rendered} /> : <p className="text-sm text-fg-3">{t('documents.previewEmpty')}</p>}</div>}
          </div>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-2 text-xs text-fg-3">
            <details><summary className="cursor-pointer hover:text-fg">{t('documents.syntaxHelp')}</summary><p className="mt-2">{t('legal.syntaxExample')}</p><p className="mt-1">{t('documents.codeHint')}</p><p className="mt-1">{t('legal.placeholders')} <code translate="no">{'{{站点名称}} · {{网址}}'}</code></p></details>
            <span className="tabular">{form.content.length.toLocaleString()} / {MAX.toLocaleString()}</span>
          </div>
        </div>
        {form.published && <div className="space-y-2 border-t border-line pt-3"><Checkbox checked={announce} onCheckedChange={setAnnounce} label={t('legal.announce')} />{announce && <Checkbox checked={email} onCheckedChange={setEmail} label={t('maintenance.email')} />}</div>}
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Modal>
  );
}

function CategoryEditor({ item, onClose }: { item?: DocumentCategoryDTO; onClose: () => void }) {
  const t = useT();
  const refresh = useRefreshDocuments();
  const [name, setName] = useState(item?.name ?? '');
  const [order, setOrder] = useState(item?.order ?? 0);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => item ? api.patch(`/admin/documents/categories/${item.id}`, { name, order }) : api.post('/admin/documents/categories', { name, order }),
    onSuccess: () => { refresh(); toast.success(t('common.saved')); onClose(); },
    onError: err => setError(errorText(err)),
  });
  return <Modal open title={t(item ? 'documents.editCategory' : 'documents.createCategory')} onOpenChange={open => !open && !save.isPending && onClose()} footer={<><Button disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" form="document-category-editor" type="submit" loading={save.isPending}>{t('common.save')}</Button></>}>
    <form id="document-category-editor" onSubmit={event => { event.preventDefault(); if (!save.isPending) save.mutate(); }} className="space-y-4">
      <FormField label={t('documents.categoryName')} required><Input required maxLength={60} value={name} onChange={e => setName(e.target.value)} /></FormField>
      <FormField label={t('common.sortOrder')}><Input required type="number" min={-10000} max={10000} value={order} onChange={e => setOrder(Number(e.target.value))} /></FormField>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  </Modal>;
}

export default function AdminDocuments() {
  const t = useT();
  const confirm = useConfirm();
  const refresh = useRefreshDocuments();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = raw === 'categories' || raw === 'registration' ? raw : 'documents';
  const [editing, setEditing] = useState<DocumentDTO | 'new' | null>(null);
  const [category, setCategory] = useState<DocumentCategoryDTO | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const q = useQuery({ queryKey: ['admin-documents'], queryFn: () => api.get<AdminDocumentsDTO>('/admin/documents') });
  const change = useMutation({
    mutationFn: (doc: DocumentDTO) => api.patch(`/admin/documents/${doc.id}`, { ...doc, published: !doc.published }),
    onSuccess: () => { refresh(); toast.success(t('common.saved')); }, onError: err => toast.fromError(err),
  });
  const remove = useMutation({
    mutationFn: ({ id, category }: { id: string; category?: boolean }) => api.delete(`/admin/documents/${category ? 'categories/' : ''}${id}`),
    onSuccess: refresh, onError: err => toast.fromError(err),
  });
  const registration = useMutation({
    mutationFn: (requireAgree: boolean) => api.patch('/admin/documents/settings', { requireAgree }),
    onSuccess: () => { refresh(); toast.success(t('common.saved')); }, onError: err => toast.fromError(err),
  });
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading />;
  const data = q.data;
  const rows = data.documents.filter(doc => (categoryId === 'all' || doc.categoryId === categoryId) && `${doc.title} ${doc.slug}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <>
    <PageHeader title={t('nav.admin.documents')} description={t('documents.subtitle')} actions={<>
      <a href="/help" target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'md')}><ExternalLink />{t('documents.publicCenter')}</a>
      {tab !== 'registration' && <Button variant="primary" icon={<Plus />} onClick={() => tab === 'categories' ? setCategory('new') : setEditing('new')}>{t(tab === 'categories' ? 'documents.createCategory' : 'documents.create')}</Button>}
    </>} />
    <TabBar<Tab> value={tab} onChange={value => setParams(value === 'documents' ? {} : { tab: value }, { replace: true })} className="mb-4" items={[
      { value: 'documents', label: t('documents.list'), count: data.documents.length, icon: <FileText /> },
      { value: 'categories', label: t('documents.categories'), count: data.categories.length, icon: <FolderOpen /> },
      { value: 'registration', label: t('legal.registration') },
    ]} />
    {tab === 'documents' && <Card>
      <Toolbar><Input aria-label={t('documents.search')} placeholder={t('documents.search')} value={search} onChange={e => setSearch(e.target.value)} className="sm:max-w-xs" /><Select aria-label={t('documents.category')} value={categoryId} onChange={setCategoryId} className="sm:w-44" options={[{ value: 'all', label: t('documents.allCategories') }, ...data.categories.map(cat => ({ value: cat.id, label: cat.name }))]} /></Toolbar>
      <DataTable rows={rows} rowKey={doc => doc.id} empty={<Empty icon={<BookOpen />} title={t('documents.empty')} />} columns={[
        { key: 'title', header: t('documents.docTitle'), cell: doc => <div className="min-w-0 max-w-lg"><button type="button" className="text-left font-medium break-words text-fg hover:underline" onClick={() => setEditing(doc)}>{doc.title}</button><div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-3"><span className="break-all font-mono">{publicPath(doc)}</span>{doc.kind && <Badge>{t('documents.builtin')}</Badge>}{doc.pinned && <Pin className="size-3" aria-label={t('dash.pinned')} />}</div></div> },
        { key: 'category', header: t('documents.category'), cell: doc => data.categories.find(cat => cat.id === doc.categoryId)?.name ?? '—' },
        { key: 'order', header: t('common.sortOrder'), cell: doc => <span className="tabular">{doc.order}</span> },
        { key: 'status', header: t('common.status'), cell: doc => <Badge tone={doc.published ? 'success' : 'neutral'}>{t(doc.published ? 'documents.published' : 'documents.draft')}</Badge> },
        { key: 'updated', header: t('common.updatedAt'), cell: doc => <span className="text-xs text-fg-3">{doc.updatedAt ? formatDate(doc.updatedAt) : t('legal.default')}</span> },
        { key: 'actions', header: t('common.actions'), cell: doc => <div className="flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(doc)}>{t('common.edit')}</Button>
          {doc.published && <a href={publicPath(doc)} target="_blank" rel="noopener noreferrer" aria-label={t('legal.view')} className={buttonClass('ghost', 'icon-sm')}><ExternalLink /></a>}
          {!doc.kind && <><Button size="icon-sm" variant="ghost" disabled={change.isPending} aria-label={t(doc.published ? 'common.hide' : 'documents.publish')} onClick={() => change.mutate(doc)}>{doc.published ? <EyeOff /> : <Eye />}</Button><Button size="icon-sm" variant="danger-ghost" disabled={remove.isPending} aria-label={t('common.delete')} onClick={async () => { if (await confirm({ title: t('documents.deleteConfirm', { title: doc.title }), description: t('documents.deleteHint'), danger: true })) remove.mutate({ id: doc.id }); }}><Trash /></Button></>}
        </div> },
      ]} />
    </Card>}
    {tab === 'categories' && <Card><DataTable rows={data.categories} rowKey={cat => cat.id} columns={[
      { key: 'name', header: t('documents.categoryName'), cell: cat => <span className="font-medium text-fg">{cat.name}{cat.id === 'general' && <Badge className="ml-2">{t('common.default')}</Badge>}</span> },
      { key: 'count', header: t('documents.documentCount'), cell: cat => data.documents.filter(doc => doc.categoryId === cat.id).length },
      { key: 'order', header: t('common.sortOrder'), cell: cat => cat.order },
      { key: 'actions', header: t('common.actions'), cell: cat => <div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setCategory(cat)}><Pencil /></Button>{cat.id !== 'general' && <Button size="icon-sm" variant="danger-ghost" disabled={remove.isPending || data.documents.some(doc => doc.categoryId === cat.id)} aria-label={t('common.delete')} title={t('documents.categoryDeleteHint')} onClick={async () => { if (await confirm({ title: t('documents.deleteConfirm', { title: cat.name }), danger: true })) remove.mutate({ id: cat.id, category: true }); }}><Trash /></Button>}</div> },
    ]} /></Card>}
    {tab === 'registration' && <Card><CardBody><div className="flex items-start justify-between gap-5"><div><h2 className="text-sm font-medium text-fg">{t('legal.agreeSwitch')}</h2><p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-fg-3">{t('legal.agreeHint')}</p></div><Switch checked={data.requireAgree} disabled={registration.isPending} onCheckedChange={value => registration.mutate(value)} label={t('legal.registration')} /></div></CardBody></Card>}
    {editing && <DocumentEditor item={editing === 'new' ? undefined : editing} data={data} onClose={() => setEditing(null)} />}
    {category && <CategoryEditor item={category === 'new' ? undefined : category} onClose={() => setCategory(null)} />}
  </>;
}
