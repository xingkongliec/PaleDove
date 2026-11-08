import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { AvatarStyle, MeDTO } from '../shared/index';
import { useI18n } from '@/i18n';
import { api } from './api';
import { applyTheme, getThemeMode, THEME_EVENT } from './theme';

/** 修改账号资料（昵称、头像风格、国家或地区、语言、外观），返回最新的用户信息 */
export async function saveProfile(body: Partial<Pick<MeDTO, 'name' | 'country' | 'locale' | 'theme' | 'announceEmail' | 'balanceAlert' | 'alertEmail'>> & { avatarStyle?: AvatarStyle; avatarVariant?: number }): Promise<MeDTO> {
  return (await api.put<{ user: MeDTO }>('/auth/profile', body)).user;
}

/**
 * 登录后按账号中保存的偏好应用语言与外观（换设备登录也保持一致）；
 * 之后在顶栏切换明暗时同步保存到账号。语言切换由请求头 x-locale 同步到服务端。
 */
export function usePreferenceSync(me: MeDTO | null | undefined) {
  const { locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const applied = useRef<number | null>(null);

  useEffect(() => {
    if (!me || applied.current === me.id) return;
    applied.current = me.id;
    if (me.theme && me.theme !== getThemeMode()) applyTheme(me.theme);
    if (me.locale && me.locale !== locale) setLocale(me.locale);
    // 只在切换账号时应用一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const onTheme = () => {
      const theme = getThemeMode();
      const current = qc.getQueryData<MeDTO | null>(['me']);
      if (!current || current.theme === theme) return;
      qc.setQueryData(['me'], { ...current, theme });
      void saveProfile({ theme }).catch(() => undefined);
    };
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, [me, qc]);
}
