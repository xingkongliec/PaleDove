import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { PopupDismissMode } from '../shared/index';
import { PopupAnnouncement, type PopupItem } from './PopupAnnouncement';
import { useMe, usePublicConfig } from '@/lib/queries';
import { dismissPopup, isPopupHidden } from '@/lib/popup-state';

export function SitePopups() {
  const { data: site } = usePublicConfig();
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const [, refresh] = useState(0);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const scope = me.data ? `user-${me.data.id}` : 'visitor';
  const eligible = !me.isPending && me.data?.role !== 'ADMIN' && !/^\/admin(?:\/|$)/.test(location.pathname);
  const items: PopupItem[] = [];
  if (eligible && site?.popups?.notice) items.push({ kind: 'notice', value: site.popups.notice });
  if (eligible && site?.popups?.promotion) items.push({ kind: 'promotion', value: site.popups.promotion });
  const item = items.find(item => !isPopupHidden(scope, item.kind, item.value.revision)) ?? null;
  const key = item ? `${scope}:${item.kind}:${item.value.revision}` : null;
  useEffect(() => {
    // Let the previous popup finish closing before opening the next one.
    if (!key) return;
    const timer = window.setTimeout(() => setShownKey(key), 300);
    return () => window.clearTimeout(timer);
  }, [key]);
  useEffect(() => {
    const reload = () => refresh(value => value + 1);
    const timer = window.setInterval(reload, 60_000);
    window.addEventListener('storage', reload);
    window.addEventListener('focus', reload);
    return () => { window.clearInterval(timer); window.removeEventListener('storage', reload); window.removeEventListener('focus', reload); };
  }, []);
  const hide = (mode: PopupDismissMode = 'session') => {
    if (!item) return;
    dismissPopup(scope, item.kind, item.value.revision, mode);
    setShownKey(null);
    refresh(value => value + 1);
  };
  return <PopupAnnouncement item={item} open={!!key && shownKey === key} onClose={() => hide()} onDismiss={hide} onPurchase={() => {
    if (item?.kind !== 'promotion' || !item.value.planId) return;
    const planId = item.value.planId;
    hide();
    navigate(`${me.data ? '/console/store' : '/store'}?plan=${planId}`);
  }} />;
}
