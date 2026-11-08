import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TICKET_FILE_TYPES } from '../shared/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { t } from '../i18n/index.ts';

const root = resolve(process.env.UPLOAD_DIR || 'data/uploads');
function filePath(key: string) {
  const path = resolve(root, key);
  if (!path.startsWith(root + sep)) throw new Error('Invalid attachment storage key');
  return path;
}
export async function removeTicketFile(key: string) {
  await unlink(filePath(key)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
export async function saveTicketFile(fileName: string, stream: Readable, truncated: () => boolean) {
  const ext = extname(fileName).toLowerCase();
  const mimeType = TICKET_FILE_TYPES[ext] ?? (/dockerfile$/i.test(fileName) ? 'text/plain' : null);
  if (!mimeType) { stream.resume(); throw badRequest(t('ticket.fileType')); }
  const storageKey = `tickets/${new Date().toISOString().slice(0, 7)}/${randomBytes(24).toString('hex')}${ext || '.txt'}`;
  const path = filePath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  try {
    await pipeline(stream, createWriteStream(path, { flags: 'wx' }));
    if (truncated()) throw badRequest(t('ticket.fileSize'));
    const { size } = await stat(path);
    return { fileName, mimeType, storageKey, size };
  } catch (error) {
    await removeTicketFile(storageKey);
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest(t('ticket.fileSize'));
    throw error;
  }
}
export async function openTicketFile(key: string) {
  const path = filePath(key);
  try { await stat(path); } catch { throw notFound(t('ticket.fileMissing')); }
  return createReadStream(path);
}
