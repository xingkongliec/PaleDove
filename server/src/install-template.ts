import { readFileSync } from 'node:fs';

type InstallTemplate = 'install.sh' | 'install-ui.sh' | 'node-uninstall.sh' | 'node-manage.sh' | 'caddy.sh' | 'agent-install.sh' | 'agent-setup.sh';

// 源码在 src/，生产入口在 dist/，均从服务目录的 templates/ 读取最新脚本。
export const installTemplateDirectory = new URL('../templates/', import.meta.url);

export function renderInstallTemplate(name: InstallTemplate, values: Record<string, string>): string {
  const template = readFileSync(new URL(name, installTemplateDirectory), 'utf8');
  // 单次替换，既不解释 shell 的 ${...}，也不再次展开插入值中的占位符。
  return template.replace(/@@PALEDOVE_([A-Z][A-Z0-9_]*)@@/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing install template value: ${key}`);
    return values[key]!;
  });
}
