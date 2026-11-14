import { operations } from './en/operations';
import { tickets } from './en/tickets';
import type { MessageKey } from './zh-CN';
import { admin } from './en/admin';
import { common } from './en/common';
import { instance } from './en/instance';
import { user } from './en/user';
import { nightMarket } from './en/night-market';

export const en: Record<MessageKey, string> = { ...common, ...user, ...instance, ...admin, ...operations, ...tickets, ...nightMarket };
