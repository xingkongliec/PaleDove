/**
 * 由简体中文消息生成繁体中文（台湾用语）消息文件。
 * 用法：pnpm i18n:tw
 */
import { writeFileSync } from 'node:fs';
import * as OpenCC from 'opencc-js';
import { zhCN as serverZhCN } from '../src/i18n/zh-CN.ts';
import { zhCN as webZhCN } from '../../web/src/i18n/zh-CN.ts';

const projectRoot = new URL('../../', import.meta.url);
const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** 转换前先替换为台湾常用的云服务术语（简体写法），再交给 OpenCC */
const PRE: [RegExp, string][] = [
  [/镜像文件/g, '映像档'],
  [/套餐/g, '方案'],
  [/访问地址/g, '存取网址'],
  [/访问/g, '存取'],
  [/实例/g, '执行个体'],
  [/端口映射/g, '连接埠转发'],
  [/端口/g, '连接埠'],
  [/映射/g, '转发'],
  [/重装/g, '重灌'],
  [/邮箱/g, '电子邮件'],
  [/演示/g, '示范'],
  [/充值/g, '储值'],
  [/账户/g, '帐户'],
  [/账单/g, '帐单'],
  [/账号/g, '帐号'],
  [/镜像/g, '映像档'],
  [/存储池/g, '储存池'],
  [/宿主机/g, '主机'],
  [/恢复快照/g, '还原快照'],
  [/重启/g, '重新启动'],
  [/反代/g, '反向代理'],
  [/流水/g, '明细'],
  [/下划线/g, '底线'],
  [/短横线/g, '连字号'],
  [/连字符/g, '连字号'],
  [/登录/g, '登入'],
  [/注册/g, '注册'],
  [/硬盘/g, '硬碟'],
  [/内存/g, '记忆体'],
  [/带宽/g, '频宽'],
  [/网关/g, '闸道'],
  [/默认/g, '预设'],
  [/文件/g, '档案'],
  [/数据/g, '资料'],
];

/** OpenCC 之后的修正 */
const POST: [RegExp, string][] = [
  [/例項/g, '執行個體'],
  [/域名/g, '網域'],
  [/連線埠/g, '連接埠'],
  [/證書/g, '憑證'],
  [/當前/g, '目前'],
  [/後臺/g, '後台'],
  [/檔案檔案/g, '檔案'],
];

function toTW(input: string): string {
  let out = input;
  for (const [re, rep] of PRE) out = out.replace(re, rep);
  out = convert(out);
  for (const [re, rep] of POST) out = out.replace(re, rep);
  return out;
}

function emit(path: string, source: Record<string, string>, typeImport: string, typeName: string, exportName: string) {
  const lines = Object.entries(source).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(toTW(v))},`);
  const body = `// 此文件由 server/scripts/gen-zh-tw.mts 自动生成，请勿手动修改\n${typeImport}\n\nexport const ${exportName}: Record<${typeName}, string> = {\n${lines.join('\n')}\n};\n`;
  writeFileSync(new URL(path, projectRoot), body);
  console.log(`wrote ${path} (${lines.length} keys)`);
}

emit('server/src/i18n/zh-TW.ts', serverZhCN, "import type { ServerMessageKey } from './zh-CN.ts';", 'ServerMessageKey', 'zhTW');
emit('web/src/i18n/zh-TW.ts', webZhCN, "import type { MessageKey } from './zh-CN';", 'MessageKey', 'zhTW');
