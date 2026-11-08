// 工单页面共用部件：状态 / 优先级标记、选项、附件选择与附件展示
import { Download, FileText, Paperclip, X } from 'lucide-react';
import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { TICKET_CATEGORIES, TICKET_FILE_TYPES, TICKET_MAX_FILE_BYTES, TICKET_MAX_FILES, TICKET_PRIORITIES, type TicketAttachmentDTO, type TicketPriority, type TicketStatus } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { Badge, type Tone } from '@/components/ui/misc';
import { useT, type TFunction } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { toast } from '@/lib/toast';

export const STATUS_TONE: Record<TicketStatus, Tone> = { OPEN: 'warning', REPLIED: 'success', CLOSED: 'neutral' };
export const PRIORITY_TONE: Record<TicketPriority, Tone> = { LOW: 'neutral', NORMAL: 'primary', HIGH: 'warning', URGENT: 'danger' };

export const categoryOptions = (t: TFunction) => TICKET_CATEGORIES.map((value) => ({ value, label: t(`ticket.category.${value}`) }));
export const priorityOptions = (t: TFunction) => TICKET_PRIORITIES.map((value) => ({ value, label: t(`ticket.priority.${value}`), description: t(`ticket.priorityDesc.${value}`) }));

export function TicketStatusBadge({ value }: { value: TicketStatus }) {
  const t = useT();
  return (
    <Badge tone={STATUS_TONE[value]} dot>
      {t(`ticket.status.${value}`)}
    </Badge>
  );
}

export function PriorityBadge({ value }: { value: TicketPriority }) {
  const t = useT();
  return <Badge tone={PRIORITY_TONE[value]}>{t(`ticket.priority.${value}`)}</Badge>;
}

const ACCEPT = Object.keys(TICKET_FILE_TYPES).join(',');
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** 校验并追加附件（类型、大小、数量），返回追加函数 */
export function useAddFiles(files: File[], setFiles: Dispatch<SetStateAction<File[]>>) {
  const t = useT();
  return (list: FileList | File[]) => {
    const valid: File[] = [];
    for (const file of Array.from(list)) {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!TICKET_FILE_TYPES[ext] && !/dockerfile$/i.test(file.name)) {
        toast.error(t('ticket.fileType', { name: file.name }));
        continue;
      }
      if (file.size > TICKET_MAX_FILE_BYTES) {
        toast.error(t('ticket.fileSize', { name: file.name }));
        continue;
      }
      valid.push(file);
    }
    if (files.length + valid.length > TICKET_MAX_FILES) toast.error(t('ticket.fileCount'));
    // 使用最新状态追加，快速连续选择也不会丢失附件
    setFiles((current) => [...current, ...valid].slice(0, TICKET_MAX_FILES));
  };
}

/** 隐藏的文件输入：render 拿到打开选择框的函数 */
export function FileInput({ onFiles, disabled, children }: { onFiles: (files: FileList) => void; disabled?: boolean; children: (open: () => void) => ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      {children(() => ref.current?.click())}
      <input
        ref={ref}
        type="file"
        multiple
        accept={ACCEPT}
        disabled={disabled}
        className="hidden"
        aria-label={t('ticket.attachments')}
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** 待上传的附件：文件名、大小，可移除 */
export function FileChips({ files, setFiles, disabled }: { files: File[]; setFiles: Dispatch<SetStateAction<File[]>>; disabled?: boolean }) {
  const t = useT();
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {files.map((file, i) => (
        <li key={`${file.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-2/60 py-0.5 pr-0.5 pl-2 text-xs">
          <FileText className="size-3.5 shrink-0 text-fg-3" />
          <span className="max-w-48 truncate text-fg-2">{file.name}</span>
          <span className="shrink-0 text-fg-4">{formatBytes(file.size)}</span>
          <Button size="icon-sm" variant="ghost" className="size-6" disabled={disabled} aria-label={t('ticket.removeFile', { name: file.name })} onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** 新建工单用的上传区：点击或拖拽文件 */
export function DropZone({ files, setFiles, disabled }: { files: File[]; setFiles: Dispatch<SetStateAction<File[]>>; disabled?: boolean }) {
  const t = useT();
  const add = useAddFiles(files, setFiles);
  const [drag, setDrag] = useState(false);
  return (
    <div className="space-y-2">
      <FileInput onFiles={add} disabled={disabled}>
        {(open) => (
          <button
            type="button"
            disabled={disabled}
            onClick={open}
            onDragOver={(e) => {
              e.preventDefault();
              if (!disabled) setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (!disabled) add(e.dataTransfer.files);
            }}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50',
              drag ? 'border-focus bg-surface-3' : 'border-line-strong hover:bg-surface-2',
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-3">
              <Paperclip className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-fg">{t('ticket.upload')}</span>
              <span className="block text-xs text-fg-3">{t('ticket.uploadHint')}</span>
            </span>
          </button>
        )}
      </FileInput>
      <FileChips files={files} setFiles={setFiles} disabled={disabled} />
    </div>
  );
}

/** 消息里的附件：图片显示缩略图（点击预览），其他文件显示为下载链接 */
export function Attachments({ list, base, align = 'start' }: { list: TicketAttachmentDTO[]; base: string; align?: 'start' | 'end' }) {
  const t = useT();
  const [preview, setPreview] = useState<TicketAttachmentDTO | null>(null);
  if (!list.length) return null;
  const url = (file: TicketAttachmentDTO) => `/api${base}/attachments/${file.id}`;
  const images = list.filter((f) => IMAGE_TYPES.includes(f.mimeType));
  return (
    <div className="mt-2.5 space-y-2">
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', align === 'end' && 'justify-end')}>
          {images.map((file) => (
            <button
              key={file.id}
              type="button"
              aria-label={t('ticket.preview', { name: file.fileName })}
              onClick={() => setPreview(file)}
              className="overflow-hidden rounded-md border border-line bg-surface-2 outline-none transition-[border-color] hover:border-line-strong focus-visible:ring-3 focus-visible:ring-ring"
            >
              <img src={url(file)} alt={file.fileName} loading="lazy" className="h-24 max-w-52 object-cover" />
            </button>
          ))}
        </div>
      )}
      <div className={cn('flex flex-wrap gap-1.5', align === 'end' && 'justify-end')}>
        {list.map((file) => (
          <a
            key={file.id}
            href={`${url(file)}?download=1`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
          >
            <Paperclip className="size-3.5 shrink-0 text-fg-3" />
            <span className="max-w-48 truncate">{file.fileName}</span>
            <span className="shrink-0 text-fg-4">{formatBytes(file.size)}</span>
            <Download className="size-3.5 shrink-0 text-fg-3" />
          </a>
        ))}
      </div>
      <Modal open={!!preview} onOpenChange={(open) => !open && setPreview(null)} title={preview?.fileName} size="xl">
        {preview && (
          <div className="space-y-3">
            <img src={url(preview)} alt={preview.fileName} className="mx-auto max-h-[65vh] max-w-full rounded" />
            <a href={`${url(preview)}?download=1`} className="inline-flex items-center gap-1 text-sm hover:underline">
              <Download className="size-4" />
              {t('ticket.download')}
            </a>
          </div>
        )}
      </Modal>
    </div>
  );
}
