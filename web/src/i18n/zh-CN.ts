import { operations } from './zh/operations';
import { tickets } from './zh/tickets';
import { admin } from './zh/admin';
import { common } from './zh/common';
import { instance } from './zh/instance';
import { user } from './zh/user';

/** 简体中文（源语言）。繁体中文由 pnpm i18n:tw 生成 */
export const zhCN = { ...common, ...user, ...instance, ...admin, ...operations, ...tickets } as const;
export type MessageKey = keyof typeof zhCN;
