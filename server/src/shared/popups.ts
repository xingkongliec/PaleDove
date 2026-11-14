export const POPUP_CONTENT_LIMIT = 5000;

export interface PopupNotice {
  enabled: boolean;
  title: string;
  content: string;
  revision: string;
}

export interface PopupPromotion {
  enabled: boolean;
  title: string;
  imageUrl: string;
  planId: number | null;
  revision: string;
}

export interface PopupSettings {
  notice: PopupNotice;
  promotion: PopupPromotion;
}

export interface AdminPopupSettingsDTO extends PopupSettings {
  plans: { id: number; name: string; productName: string }[];
}

export interface PublicPopupsDTO {
  notice: PopupNotice | null;
  promotion: PopupPromotion | null;
}

export type PopupDismissMode = 'session' | 'today' | 'forever';
export interface PopupDismissal { revision: string; until: number | 'forever' }

export function nextLocalMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

export function popupDismissed(value: unknown, revision: string, now = Date.now()): boolean {
  if (!value || typeof value !== 'object') return false;
  const stored = value as Partial<PopupDismissal>;
  return stored.revision === revision && (stored.until === 'forever' || (typeof stored.until === 'number' && Number.isFinite(stored.until) && stored.until > now));
}
