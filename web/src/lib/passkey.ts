import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import type { LoginResultDTO, PasskeyDTO } from '../shared/index';
import type { TFunction } from '@/i18n';
import { api, errorText } from './api';

/** 当前浏览器是否支持通行密钥（WebAuthn） */
export const passkeySupported = () => typeof window !== 'undefined' && browserSupportsWebAuthn();

type StartRegistration = Parameters<typeof startRegistration>[0]['optionsJSON'];
type StartAuthentication = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/** 添加通行密钥：取注册选项 → 由浏览器 / 系统创建凭据 → 交给服务端校验保存 */
export async function registerPasskey(name?: string) {
  const optionsJSON = await api.post<StartRegistration>('/auth/passkeys/options');
  const response = await startRegistration({ optionsJSON });
  return api.post<PasskeyDTO>('/auth/passkeys', { response, ...(name ? { name } : {}) });
}

/** 通行密钥登录：不需要先输入账号，浏览器会列出本机保存的通行密钥 */
export async function loginWithPasskey() {
  const { challengeId, options } = await api.post<{ challengeId: string; options: StartAuthentication }>('/auth/login/passkey/options');
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<LoginResultDTO>('/auth/login/passkey', { challengeId, response });
}

/** 用户关闭了系统弹窗或超时：不算错误，不提示 */
function cancelled(e: unknown) {
  const names = [e instanceof Error ? e.name : '', e instanceof Error && e.cause instanceof Error ? e.cause.name : ''];
  return names.some((n) => n === 'NotAllowedError' || n === 'AbortError');
}

/** 通行密钥操作的错误提示；用户取消时返回 null */
export function passkeyError(e: unknown, t: TFunction): string | null {
  if (cancelled(e)) return null;
  if (e instanceof WebAuthnError) {
    if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return t('passkey.alreadyAdded');
    if (e.code === 'ERROR_INVALID_DOMAIN' || e.code === 'ERROR_INVALID_RP_ID') return t('passkey.badDomain');
    if (e.code === 'ERROR_CEREMONY_ABORTED') return null;
  }
  return errorText(e);
}
