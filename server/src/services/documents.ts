import { randomUUID } from 'node:crypto';
import type { AdminDocumentsDTO, DocumentCategoryDTO, DocumentDTO, PublicDocumentsDTO } from '../shared/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { getSetting, getSettings, setSetting } from '../lib/settings.ts';
import { withLock } from '../lib/redis.ts';
import { t } from '../i18n/index.ts';
import { DEFAULT_LEGAL, fillLegal, LEGAL_KINDS, type LegalSettings } from './legal.ts';

export const DOCUMENTS_LOCK = 'settings:legal';
export type DocumentInput = Pick<DocumentDTO, 'title' | 'slug' | 'content' | 'categoryId' | 'order' | 'published' | 'pinned'>;
const normalize = (value: string) => value.replace(/\r\n?/g, '\n').trim();

export function managedDocuments(settings: LegalSettings): DocumentDTO[] {
  const builtins = LEGAL_KINDS.map((kind, order): DocumentDTO => ({
    id: kind, kind, slug: kind, title: t(`legal.${kind}`), categoryId: 'general', order, pinned: false,
    ...settings.documentMeta[kind],
    content: settings[kind].content || DEFAULT_LEGAL[kind], published: true, updatedAt: settings[kind].updatedAt || null,
  }));
  return [...builtins, ...settings.documents].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.slug.localeCompare(b.slug));
}

export async function adminDocuments(): Promise<AdminDocumentsDTO> {
  const settings = await getSetting('legal');
  return { documents: managedDocuments(settings), categories: [...settings.categories].sort((a, b) => a.order - b.order), requireAgree: settings.requireAgree, defaults: DEFAULT_LEGAL };
}

export async function publicDocuments(): Promise<PublicDocumentsDTO> {
  const settings = await getSetting('legal');
  const documents = managedDocuments(settings).filter(doc => doc.published).map(({ content: _content, ...doc }) => doc);
  return { documents, categories: [...settings.categories].filter(cat => documents.some(doc => doc.categoryId === cat.id)).sort((a, b) => a.order - b.order) };
}

export async function publicDocument(slug: string, baseUrl: string): Promise<DocumentDTO> {
  const [settings, site] = await Promise.all([getSetting('legal'), getSettings()]);
  const doc = managedDocuments(settings).find(item => item.slug === slug && item.published);
  if (!doc) throw notFound(t('documents.notFound'));
  return { ...doc, content: fillLegal(doc.content, site.siteName, baseUrl) };
}

export async function saveDocument(id: string | null, input: DocumentInput) {
  return withLock(DOCUMENTS_LOCK, 15_000, async () => {
    // Read after acquiring the lock so another API process's cached value cannot overwrite a recent edit.
    const settings = await getSetting('legal', true);
    const documents = managedDocuments(settings);
    const current = id ? documents.find(doc => doc.id === id) : undefined;
    if (id && !current) throw notFound(t('documents.notFound'));
    if (documents.some(doc => doc.slug === input.slug && doc.id !== id)) throw conflict(t('documents.slugTaken'));
    if (!settings.categories.some(cat => cat.id === input.categoryId)) throw badRequest(t('documents.categoryMissing'));
    if (!current && settings.documents.length >= 200) throw badRequest(t('documents.limit'));
    if (current?.kind && (input.slug !== current.kind || !input.published)) throw badRequest(t('documents.builtinProtected'));
    const content = normalize(input.content);
    if (!content) throw badRequest(t('documents.contentRequired'));
    const changed = !current || normalize(current.content) !== content;
    const doc: DocumentDTO = {
      ...input, content, id: current?.id ?? randomUUID(), kind: current?.kind ?? null,
      updatedAt: changed || current?.title !== input.title ? new Date().toISOString() : current?.updatedAt ?? null,
    };
    if (doc.kind) {
      await setSetting('legal', {
        [doc.kind]: { content: content === DEFAULT_LEGAL[doc.kind].trim() ? '' : content, updatedAt: doc.updatedAt ?? '' },
        documentMeta: { ...settings.documentMeta, [doc.kind]: { title: doc.title, categoryId: doc.categoryId, order: doc.order, pinned: doc.pinned } },
      });
    } else {
      await setSetting('legal', { documents: current ? settings.documents.map(item => item.id === id ? doc : item) : [...settings.documents, doc] });
    }
    return { doc, changed };
  });
}

export async function deleteDocument(id: string) {
  return withLock(DOCUMENTS_LOCK, 15_000, async () => {
    const settings = await getSetting('legal', true);
    const doc = managedDocuments(settings).find(item => item.id === id);
    if (!doc) throw notFound(t('documents.notFound'));
    if (doc.kind) throw badRequest(t('documents.builtinProtected'));
    await setSetting('legal', { documents: settings.documents.filter(item => item.id !== id) });
    return doc;
  });
}

export async function saveDocumentCategory(id: string | null, input: Pick<DocumentCategoryDTO, 'name' | 'order'>) {
  return withLock(DOCUMENTS_LOCK, 15_000, async () => {
    const settings = await getSetting('legal', true);
    if (id && !settings.categories.some(cat => cat.id === id)) throw notFound(t('documents.categoryMissing'));
    if (settings.categories.some(cat => cat.id !== id && cat.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw conflict(t('documents.categoryTaken'));
    if (!id && settings.categories.length >= 50) throw badRequest(t('documents.categoryLimit'));
    const category = { ...input, id: id ?? randomUUID() };
    await setSetting('legal', { categories: id ? settings.categories.map(cat => cat.id === id ? category : cat) : [...settings.categories, category] });
    return category;
  });
}

export async function deleteDocumentCategory(id: string) {
  return withLock(DOCUMENTS_LOCK, 15_000, async () => {
    const settings = await getSetting('legal', true);
    if (!settings.categories.some(cat => cat.id === id)) throw notFound(t('documents.categoryMissing'));
    if (id === 'general') throw badRequest(t('documents.defaultCategoryProtected'));
    if (managedDocuments(settings).some(doc => doc.categoryId === id)) throw badRequest(t('documents.categoryInUse'));
    await setSetting('legal', { categories: settings.categories.filter(cat => cat.id !== id) });
  });
}
