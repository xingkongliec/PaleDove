import { Toast } from '@base-ui/react/toast';
import { t } from '@/i18n';
import { errorText } from './api';

/** 全局 Toast 管理器，可在 React 组件之外调用 */
export const toastManager = Toast.createToastManager();

export const toast = {
  success(title: string, description?: string) {
    toastManager.add({ title, description, type: 'success' });
  },
  error(title: string, description?: string) {
    toastManager.add({ title, description, type: 'error', timeout: 8000 });
  },
  info(title: string, description?: string) {
    toastManager.add({ title, description, type: 'info' });
  },
  fromError(err: unknown, title?: string) {
    toastManager.add({ title: title ?? t('common.operationFailed'), description: errorText(err), type: 'error', timeout: 8000 });
  },
};
