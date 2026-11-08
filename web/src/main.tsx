import { Tooltip } from '@base-ui/react/tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { ConfirmProvider } from './components/ui/confirm';
import { ToastProvider } from './components/ui/toaster';
import { I18nProvider } from './i18n';
import { queryClient } from './lib/queries';
import { captureAff } from './lib/aff';
import { applyTheme, getThemeMode } from './lib/theme';
import './styles.css';

applyTheme(getThemeMode());
captureAff();

// 切换语言后重新拉取由服务端翻译的内容（错误信息、支付方式名称等）
const onLocaleChange = () => void queryClient.invalidateQueries();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider onChange={onLocaleChange}>
        <ToastProvider>
          <Tooltip.Provider delay={300}>
            <ConfirmProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ConfirmProvider>
          </Tooltip.Provider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
