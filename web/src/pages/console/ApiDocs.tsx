// API 文档：API 令牌可调用的控制台接口。路径、方法、参数名写在这里，说明文字走 i18n
import { ChevronRight, KeyRound, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/page';
import { LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CodeBlock, Empty, Tag, type Tone } from '@/components/ui/misc';
import { useI18n, type MessageKey } from '@/i18n';
import { cn } from '@/lib/cn';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WS';

interface Param {
  name: string;
  in: 'path' | 'query' | 'body';
  type: string;
  required?: boolean;
  desc: MessageKey;
}

interface Endpoint {
  method: Method;
  path: string;
  desc: MessageKey;
  params?: Param[];
  /** 请求体示例（生成 curl） */
  body?: Record<string, unknown>;
  /** 查询参数示例（生成 curl） */
  query?: string;
  returns?: MessageKey;
}

interface Group {
  id: string;
  title: MessageKey;
  endpoints: Endpoint[];
}

// 常用参数
const ID: Param = { name: 'id', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.id' };
const PAGE: Param[] = [
  { name: 'page', in: 'query', type: 'number', desc: 'apiDocs.p.page' },
  { name: 'pageSize', in: 'query', type: 'number', desc: 'apiDocs.p.pageSize' },
];
const PASSWORD: Param = { name: 'password', in: 'body', type: 'string', desc: 'apiDocs.p.password' };
const SSH_KEYS: Param = { name: 'sshKeys', in: 'body', type: 'string', desc: 'apiDocs.p.sshKeys' };
const IDS: Param = { name: 'ids', in: 'body', type: 'number[]', desc: 'apiDocs.p.messageIds' };
const pathId = (name: string, desc: MessageKey): Param => ({ name, in: 'path', type: 'number', required: true, desc });

const GROUPS: Group[] = [
  {
    id: 'account',
    title: 'apiDocs.g.account',
    endpoints: [
      { method: 'GET', path: '/auth/me', desc: 'apiDocs.ep.me' },
      { method: 'GET', path: '/dashboard', desc: 'apiDocs.ep.dashboard' },
      { method: 'GET', path: '/billing/summary', desc: 'apiDocs.ep.billingSummary' },
      { method: 'GET', path: '/billing/logs', desc: 'apiDocs.ep.billingLogs', params: PAGE, returns: 'apiDocs.r.paged' },
      { method: 'GET', path: '/billing/orders', desc: 'apiDocs.ep.billingOrders', params: PAGE, returns: 'apiDocs.r.paged' },
      {
        method: 'POST',
        path: '/billing/redeem',
        desc: 'apiDocs.ep.redeem',
        params: [{ name: 'code', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.code' }],
        body: { code: 'XXXX-XXXX-XXXX' },
      },
      {
        method: 'GET',
        path: '/messages',
        desc: 'apiDocs.ep.messages',
        params: [...PAGE, { name: 'unread', in: 'query', type: 'boolean', desc: 'apiDocs.p.unread' }],
        returns: 'apiDocs.r.paged',
      },
      { method: 'POST', path: '/messages/read', desc: 'apiDocs.ep.messagesRead', params: [IDS], body: { ids: [1, 2] }, returns: 'apiDocs.r.ok' },
      { method: 'POST', path: '/messages/delete', desc: 'apiDocs.ep.messagesDelete', params: [IDS], body: { ids: [1] }, returns: 'apiDocs.r.ok' },
      { method: 'GET', path: '/announcements', desc: 'apiDocs.ep.announcements' },
      {
        method: 'POST',
        path: '/announcements/read',
        desc: 'apiDocs.ep.announcementsRead',
        params: [{ name: 'ids', in: 'body', type: 'number[]', desc: 'apiDocs.p.announcementIds' }],
        body: { ids: [3] },
        returns: 'apiDocs.r.ok',
      },
      {
        method: 'GET',
        path: '/logs',
        desc: 'apiDocs.ep.logs',
        params: [
          ...PAGE,
          { name: 'q', in: 'query', type: 'string', desc: 'apiDocs.p.logQuery' },
          { name: 'module', in: 'query', type: '"auth" | "account" | "instance" | "billing" | "ticket" | …', desc: 'apiDocs.p.logModule' },
        ],
        returns: 'apiDocs.r.paged',
      },
    ],
  },
  {
    id: 'sshKeys',
    title: 'apiDocs.g.sshKeys',
    endpoints: [
      { method: 'GET', path: '/ssh-keys', desc: 'apiDocs.ep.sshKeys' },
      {
        method: 'POST',
        path: '/ssh-keys',
        desc: 'apiDocs.ep.sshKeyAdd',
        params: [
          { name: 'publicKey', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.publicKey' },
          { name: 'name', in: 'body', type: 'string', desc: 'apiDocs.p.keyName' },
        ],
        body: { name: 'laptop', publicKey: 'ssh-ed25519 AAAA... user@host' },
      },
      {
        method: 'PATCH',
        path: '/ssh-keys/:kid',
        desc: 'apiDocs.ep.sshKeyRename',
        params: [pathId('kid', 'apiDocs.p.keyId'), { name: 'name', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.keyName' }],
        body: { name: 'work' },
      },
      { method: 'DELETE', path: '/ssh-keys/:kid', desc: 'apiDocs.ep.sshKeyDelete', params: [pathId('kid', 'apiDocs.p.keyId')], returns: 'apiDocs.r.ok' },
    ],
  },
  {
    id: 'billing',
    title: 'apiDocs.g.billing',
    endpoints: [
      { method: 'GET', path: '/payments/options', desc: 'apiDocs.ep.payOptions' },
      {
        method: 'POST',
        path: '/payments',
        desc: 'apiDocs.ep.payCreate',
        params: [
          { name: 'channelId', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.channelId' },
          { name: 'method', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.payMethod' },
          { name: 'amount', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.payAmount' },
          { name: 'device', in: 'body', type: '"pc" | "mobile"', desc: 'apiDocs.p.device' },
        ],
        body: { channelId: 'epay-1', method: 'alipay', amount: 50 },
        returns: 'apiDocs.r.payment',
      },
      { method: 'GET', path: '/payments', desc: 'apiDocs.ep.payments', params: PAGE, returns: 'apiDocs.r.paged' },
      { method: 'GET', path: '/payments/:no', desc: 'apiDocs.ep.payment', params: [{ name: 'no', in: 'path', type: 'string', required: true, desc: 'apiDocs.p.paymentNo' }] },
    ],
  },
  {
    id: 'aff',
    title: 'apiDocs.g.aff',
    endpoints: [
      { method: 'GET', path: '/aff', desc: 'apiDocs.ep.aff' },
      { method: 'GET', path: '/aff/logs', desc: 'apiDocs.ep.affLogs', params: PAGE, returns: 'apiDocs.r.paged' },
      { method: 'POST', path: '/aff/withdraw', desc: 'apiDocs.ep.affWithdraw', returns: 'apiDocs.r.affWithdraw' },
    ],
  },
  {
    id: 'market',
    title: 'apiDocs.g.market',
    endpoints: [
      {
        method: 'GET',
        path: '/public/market',
        desc: 'apiDocs.ep.market',
        params: [
          ...PAGE,
          { name: 'region', in: 'query', type: 'string', desc: 'apiDocs.p.marketRegion' },
          { name: 'type', in: 'query', type: '"LXC_NAT" | "KVM_NAT" | "KVM_IPV4"', desc: 'apiDocs.p.marketType' },
          { name: 'q', in: 'query', type: 'string', desc: 'apiDocs.p.marketQuery' },
          { name: 'sort', in: 'query', type: '"NEWEST" | "PRICE_ASC" | "PRICE_DESC" | "EXPIRES_DESC"', desc: 'apiDocs.p.marketSort' },
        ],
        query: '?region=Tokyo&sort=PRICE_ASC',
        returns: 'apiDocs.r.paged',
      },
      {
        method: 'GET',
        path: '/public/market/:id/history',
        desc: 'apiDocs.ep.marketHistory',
        params: [ID, { name: 'kind', in: 'query', type: '"ALL" | "PUBLIC" | "TARGETED"', desc: 'apiDocs.p.marketKind' }],
        query: '?kind=ALL',
      },
      { method: 'GET', path: '/public/market/:id/ping', desc: 'apiDocs.ep.marketPing', params: [ID], returns: 'apiDocs.r.marketPing' },
      { method: 'GET', path: '/market/sellable', desc: 'apiDocs.ep.marketSellable' },
      { method: 'GET', path: '/market/mine', desc: 'apiDocs.ep.marketMine' },
      { method: 'GET', path: '/market/purchases', desc: 'apiDocs.ep.marketPurchases' },
      {
        method: 'POST',
        path: '/market/listings',
        desc: 'apiDocs.ep.marketCreate',
        params: [
          { name: 'instanceId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.marketInstance' },
          { name: 'price', in: 'body', type: 'string | number', required: true, desc: 'apiDocs.p.marketPrice' },
          { name: 'target', in: 'body', type: 'string', desc: 'apiDocs.p.marketTarget' },
        ],
        body: { instanceId: 12, price: 20 },
        returns: 'apiDocs.r.marketCreate',
      },
      {
        method: 'PATCH',
        path: '/market/listings/:id',
        desc: 'apiDocs.ep.marketUpdate',
        params: [ID, { name: 'price', in: 'body', type: 'string | number', desc: 'apiDocs.p.marketPrice' }],
        body: { price: 18 },
      },
      { method: 'DELETE', path: '/market/listings/:id', desc: 'apiDocs.ep.marketCancel', params: [ID], returns: 'apiDocs.r.ok' },
      { method: 'POST', path: '/market/listings/:id/ping', desc: 'apiDocs.ep.marketRetest', params: [ID] },
      { method: 'POST', path: '/market/listings/:id/buy', desc: 'apiDocs.ep.marketBuy', params: [ID], returns: 'apiDocs.r.marketBuy' },
    ],
  },
  {
    id: 'store',
    title: 'apiDocs.g.store',
    endpoints: [
      { method: 'GET', path: '/store/products', desc: 'apiDocs.ep.products' },
      { method: 'GET', path: '/store/plans', desc: 'apiDocs.ep.plans' },
      { method: 'GET', path: '/store/images', desc: 'apiDocs.ep.storeImages' },
      {
        method: 'POST',
        path: '/store/orders',
        desc: 'apiDocs.ep.order',
        params: [
          { name: 'planId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.planId' },
          { name: 'region', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.region' },
          { name: 'imageId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.imageId' },
          { name: 'cycle', in: 'body', type: '"MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL"', required: true, desc: 'apiDocs.p.cycle' },
          { name: 'hostname', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.hostname' },
          PASSWORD,
          SSH_KEYS,
          { name: 'couponCode', in: 'body', type: 'string', desc: 'apiDocs.p.couponCode' },
        ],
        body: { planId: 1, region: 'HK', imageId: 1, cycle: 'MONTHLY', hostname: 'web-01' },
        returns: 'apiDocs.r.order',
      },
      {
        method: 'POST',
        path: '/store/coupon',
        desc: 'apiDocs.ep.coupon',
        params: [
          { name: 'kind', in: 'body', type: '"NEW" | "RENEW"', required: true, desc: 'apiDocs.p.couponKind' },
          { name: 'code', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.couponCode' },
          { name: 'planId', in: 'body', type: 'number', desc: 'apiDocs.p.couponPlan' },
          { name: 'cycle', in: 'body', type: 'string', desc: 'apiDocs.p.cycle' },
          { name: 'instanceId', in: 'body', type: 'number', desc: 'apiDocs.p.couponInstance' },
          { name: 'periods', in: 'body', type: 'number', desc: 'apiDocs.p.periods' },
        ],
        body: { kind: 'NEW', code: 'SAVE10', planId: 1, cycle: 'MONTHLY' },
        returns: 'apiDocs.r.coupon',
      },
    ],
  },
  {
    id: 'instances',
    title: 'apiDocs.g.instances',
    endpoints: [
      { method: 'GET', path: '/instances', desc: 'apiDocs.ep.instances' },
      { method: 'GET', path: '/instances/:id', desc: 'apiDocs.ep.instance', params: [ID] },
      {
        method: 'PATCH',
        path: '/instances/:id',
        desc: 'apiDocs.ep.instanceUpdate',
        params: [
          ID,
          { name: 'hostname', in: 'body', type: 'string', desc: 'apiDocs.p.hostname' },
          { name: 'autoRenew', in: 'body', type: 'boolean', desc: 'apiDocs.p.autoRenew' },
        ],
        body: { autoRenew: true },
        returns: 'apiDocs.r.instance',
      },
      {
        method: 'DELETE',
        path: '/instances/:id',
        desc: 'apiDocs.ep.instanceDelete',
        params: [ID, { name: 'confirm', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.confirm' }],
        body: { confirm: 'web-01' },
        returns: 'apiDocs.r.ok',
      },
      { method: 'GET', path: '/instances/:id/credentials', desc: 'apiDocs.ep.credentials', params: [ID] },
      {
        method: 'POST',
        path: '/instances/:id/renew',
        desc: 'apiDocs.ep.renew',
        params: [ID, { name: 'periods', in: 'body', type: 'number', desc: 'apiDocs.p.periods' }],
        body: { periods: 1 },
        returns: 'apiDocs.r.instance',
      },
      {
        method: 'POST',
        path: '/instances/:id/transfer',
        desc: 'apiDocs.ep.transfer',
        params: [
          ID,
          { name: 'target', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.target' },
          { name: 'mode', in: 'body', type: '"KEEP" | "REINSTALL"', required: true, desc: 'apiDocs.p.mode' },
          { name: 'imageId', in: 'body', type: 'number', desc: 'apiDocs.p.transferImage' },
          { name: 'remark', in: 'body', type: 'string', desc: 'apiDocs.p.transferRemark' },
          { name: 'confirm', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.confirm' },
        ],
        body: { target: 'alice', mode: 'KEEP', confirm: 'web-01' },
      },
      {
        method: 'GET',
        path: '/instances/:id/transfer/check',
        desc: 'apiDocs.ep.transferCheck',
        params: [ID, { name: 'target', in: 'query', type: 'string', desc: 'apiDocs.p.target' }],
        query: '?target=alice',
        returns: 'apiDocs.r.transferCheck',
      },
      { method: 'GET', path: '/transfers', desc: 'apiDocs.ep.transfers' },
      { method: 'POST', path: '/instances/:id/reset-traffic', desc: 'apiDocs.ep.resetTraffic', params: [ID], returns: 'apiDocs.r.resetTraffic' },
      { method: 'GET', path: '/instances/:id/volumes', desc: 'apiDocs.ep.volumes', params: [ID] },
      {
        method: 'POST',
        path: '/instances/:id/swap',
        desc: 'apiDocs.ep.swap',
        params: [ID, { name: 'enabled', in: 'body', type: 'boolean', required: true, desc: 'apiDocs.p.swapEnabled' }],
        body: { enabled: true },
      },
      { method: 'GET', path: '/instances/:id/egress', desc: 'apiDocs.ep.egress', params: [ID] },
      {
        method: 'PUT',
        path: '/instances/:id/egress',
        desc: 'apiDocs.ep.egressSet',
        params: [ID, { name: 'egressId', in: 'body', type: 'number | null', required: true, desc: 'apiDocs.p.egressId' }],
        body: { egressId: 2 },
        returns: 'apiDocs.r.ok',
      },
      { method: 'GET', path: '/instances/:id/switch-node', desc: 'apiDocs.ep.switchInfo', params: [ID] },
      {
        method: 'GET',
        path: '/instances/:id/switch-node/check',
        desc: 'apiDocs.ep.switchCheck',
        params: [ID, { name: 'fresh', in: 'query', type: 'boolean', desc: 'apiDocs.p.switchFresh' }],
        query: '?fresh=1',
      },
      {
        method: 'POST',
        path: '/instances/:id/switch-node',
        desc: 'apiDocs.ep.switchNode',
        params: [
          ID,
          { name: 'targetNodeId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.targetNodeId' },
          { name: 'imageId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.imageId' },
          PASSWORD,
          SSH_KEYS,
        ],
        body: { targetNodeId: 3, imageId: 5 },
        returns: 'apiDocs.r.switchNode',
      },
    ],
  },
  {
    id: 'ops',
    title: 'apiDocs.g.ops',
    endpoints: [
      {
        method: 'POST',
        path: '/instances/:id/power',
        desc: 'apiDocs.ep.power',
        params: [ID, { name: 'action', in: 'body', type: '"start" | "stop" | "restart" | "force_stop"', required: true, desc: 'apiDocs.p.action' }],
        body: { action: 'restart' },
        returns: 'apiDocs.r.task',
      },
      { method: 'GET', path: '/instances/:id/images', desc: 'apiDocs.ep.images', params: [ID] },
      {
        method: 'POST',
        path: '/instances/:id/reinstall',
        desc: 'apiDocs.ep.reinstall',
        params: [ID, { name: 'imageId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.reinstallImage' }, PASSWORD, SSH_KEYS],
        body: { imageId: 1 },
        returns: 'apiDocs.r.taskPassword',
      },
      {
        method: 'POST',
        path: '/instances/:id/reset-password',
        desc: 'apiDocs.ep.resetPassword',
        params: [ID, PASSWORD],
        body: {},
        returns: 'apiDocs.r.taskPassword',
      },
      { method: 'GET', path: '/instances/:id/tasks', desc: 'apiDocs.ep.instanceTasks', params: [ID] },
      { method: 'GET', path: '/tasks', desc: 'apiDocs.ep.tasks', params: PAGE, returns: 'apiDocs.r.paged' },
    ],
  },
  {
    id: 'monitor',
    title: 'apiDocs.g.monitor',
    endpoints: [
      { method: 'GET', path: '/instances/:id/state', desc: 'apiDocs.ep.state', params: [ID] },
      {
        method: 'GET',
        path: '/instances/:id/metrics',
        desc: 'apiDocs.ep.metrics',
        params: [ID, { name: 'minutes', in: 'query', type: 'number', desc: 'apiDocs.p.minutes' }],
      },
      { method: 'GET', path: '/instances/:id/traffic', desc: 'apiDocs.ep.traffic', params: [ID] },
    ],
  },
  {
    id: 'ports',
    title: 'apiDocs.g.ports',
    endpoints: [
      { method: 'GET', path: '/ports', desc: 'apiDocs.ep.allPorts' },
      { method: 'GET', path: '/instances/:id/ports', desc: 'apiDocs.ep.ports', params: [ID] },
      {
        method: 'POST',
        path: '/instances/:id/ports',
        desc: 'apiDocs.ep.portAdd',
        params: [
          ID,
          { name: 'privatePort', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.privatePort' },
          { name: 'publicPort', in: 'body', type: 'number', desc: 'apiDocs.p.publicPort' },
          { name: 'protocol', in: 'body', type: '"TCP" | "UDP" | "TCP_UDP"', desc: 'apiDocs.p.protocol' },
          { name: 'description', in: 'body', type: 'string', desc: 'apiDocs.p.portNote' },
        ],
        body: { privatePort: 80, protocol: 'TCP', description: 'web' },
      },
      {
        method: 'PATCH',
        path: '/instances/:id/ports/:mid',
        desc: 'apiDocs.ep.portUpdate',
        params: [ID, { name: 'mid', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.mid' }, { name: 'description', in: 'body', type: 'string | null', required: true, desc: 'apiDocs.p.portNote' }],
        body: { description: 'nginx' },
      },
      {
        method: 'DELETE',
        path: '/instances/:id/ports/:mid',
        desc: 'apiDocs.ep.portDelete',
        params: [ID, { name: 'mid', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.mid' }],
        returns: 'apiDocs.r.ok',
      },
    ],
  },
  {
    id: 'sites',
    title: 'apiDocs.g.sites',
    endpoints: [
      { method: 'GET', path: '/sites', desc: 'apiDocs.ep.allSites' },
      { method: 'GET', path: '/instances/:id/sites', desc: 'apiDocs.ep.sites', params: [ID] },
      {
        method: 'POST',
        path: '/instances/:id/sites',
        desc: 'apiDocs.ep.siteAdd',
        params: [
          ID,
          { name: 'domain', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.domain' },
          { name: 'targetPort', in: 'body', type: 'number', desc: 'apiDocs.p.targetPort' },
          { name: 'https', in: 'body', type: 'boolean', desc: 'apiDocs.p.https' },
        ],
        body: { domain: 'blog.example.com', targetPort: 80, https: true },
      },
      {
        method: 'PATCH',
        path: '/instances/:id/sites/:sid',
        desc: 'apiDocs.ep.siteUpdate',
        params: [
          ID,
          { name: 'sid', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.sid' },
          { name: 'targetPort', in: 'body', type: 'number', desc: 'apiDocs.p.targetPort' },
          { name: 'https', in: 'body', type: 'boolean', desc: 'apiDocs.p.https' },
        ],
        body: { targetPort: 8080 },
      },
      {
        method: 'DELETE',
        path: '/instances/:id/sites/:sid',
        desc: 'apiDocs.ep.siteDelete',
        params: [ID, { name: 'sid', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.sid' }],
        returns: 'apiDocs.r.ok',
      },
    ],
  },
  {
    id: 'snapshots',
    title: 'apiDocs.g.snapshots',
    endpoints: [
      { method: 'GET', path: '/snapshots', desc: 'apiDocs.ep.allSnapshots' },
      { method: 'GET', path: '/instances/:id/snapshots', desc: 'apiDocs.ep.snapshots', params: [ID] },
      {
        method: 'POST',
        path: '/instances/:id/snapshots',
        desc: 'apiDocs.ep.snapshotCreate',
        params: [ID, { name: 'description', in: 'body', type: 'string', desc: 'apiDocs.p.snapshotNote' }],
        body: { description: 'before upgrade' },
        returns: 'apiDocs.r.task',
      },
      {
        method: 'POST',
        path: '/instances/:id/snapshots/:sid/restore',
        desc: 'apiDocs.ep.snapshotRestore',
        params: [ID, { name: 'sid', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.snapshotId' }],
        returns: 'apiDocs.r.task',
      },
      {
        method: 'DELETE',
        path: '/instances/:id/snapshots/:sid',
        desc: 'apiDocs.ep.snapshotDelete',
        params: [ID, { name: 'sid', in: 'path', type: 'number', required: true, desc: 'apiDocs.p.snapshotId' }],
        returns: 'apiDocs.r.task',
      },
    ],
  },
  {
    id: 'vpc',
    title: 'apiDocs.g.vpc',
    endpoints: [
      { method: 'GET', path: '/vpcs', desc: 'apiDocs.ep.vpcs' },
      {
        method: 'POST',
        path: '/vpcs',
        desc: 'apiDocs.ep.vpcCreate',
        params: [
          { name: 'name', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.vpcName' },
          { name: 'nodeId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.vpcNode' },
          { name: 'cidr', in: 'body', type: 'string', desc: 'apiDocs.p.vpcCidr' },
        ],
        body: { name: 'backend', nodeId: 1, cidr: '10.10.0.0/24' },
      },
      {
        method: 'PATCH',
        path: '/vpcs/:vpcId',
        desc: 'apiDocs.ep.vpcRename',
        params: [pathId('vpcId', 'apiDocs.p.vpcId'), { name: 'name', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.vpcName' }],
        body: { name: 'backend-2' },
      },
      { method: 'DELETE', path: '/vpcs/:vpcId', desc: 'apiDocs.ep.vpcDelete', params: [pathId('vpcId', 'apiDocs.p.vpcId')], returns: 'apiDocs.r.ok' },
      {
        method: 'POST',
        path: '/vpcs/:vpcId/instances',
        desc: 'apiDocs.ep.vpcJoin',
        params: [
          pathId('vpcId', 'apiDocs.p.vpcId'),
          { name: 'instanceId', in: 'body', type: 'number', required: true, desc: 'apiDocs.p.instanceId' },
          { name: 'ip', in: 'body', type: 'string', desc: 'apiDocs.p.vpcIp' },
        ],
        body: { instanceId: 1, ip: '10.10.0.5' },
      },
      { method: 'DELETE', path: '/vpcs/:vpcId/instances/:instanceId', desc: 'apiDocs.ep.vpcLeave', params: [pathId('vpcId', 'apiDocs.p.vpcId'), pathId('instanceId', 'apiDocs.p.instanceId')] },
    ],
  },
  {
    id: 'tickets',
    title: 'apiDocs.g.tickets',
    endpoints: [
      {
        method: 'GET',
        path: '/tickets',
        desc: 'apiDocs.ep.tickets',
        params: [...PAGE, { name: 'status', in: 'query', type: '"OPEN" | "REPLIED" | "CLOSED"', desc: 'apiDocs.p.ticketStatus' }, { name: 'q', in: 'query', type: 'string', desc: 'apiDocs.p.ticketQuery' }],
        returns: 'apiDocs.r.paged',
      },
      { method: 'GET', path: '/tickets/stats', desc: 'apiDocs.ep.ticketStats' },
      {
        method: 'POST',
        path: '/tickets',
        desc: 'apiDocs.ep.ticketCreate',
        params: [
          { name: 'subject', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.ticketSubject' },
          { name: 'content', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.ticketContent' },
          { name: 'category', in: 'body', type: '"container" | "disk" | "network" | "domain" | "billing" | "account" | "other"', desc: 'apiDocs.p.ticketCategory' },
          { name: 'priority', in: 'body', type: '"LOW" | "NORMAL" | "HIGH" | "URGENT"', desc: 'apiDocs.p.ticketPriority' },
          { name: 'resourceRef', in: 'body', type: 'number', desc: 'apiDocs.p.ticketInstance' },
        ],
        body: { subject: 'Cannot SSH', content: 'Connection timed out since 10:00', category: 'network', resourceRef: 1 },
      },
      { method: 'GET', path: '/tickets/:tid', desc: 'apiDocs.ep.ticket', params: [pathId('tid', 'apiDocs.p.ticketId')] },
      {
        method: 'GET',
        path: '/tickets/:tid/attachments/:aid',
        desc: 'apiDocs.ep.ticketAttachment',
        params: [pathId('tid', 'apiDocs.p.ticketId'), pathId('aid', 'apiDocs.p.attachmentId'), { name: 'inline', in: 'query', type: 'boolean', desc: 'apiDocs.p.attachmentInline' }],
        returns: 'apiDocs.r.file',
      },
      {
        method: 'POST',
        path: '/tickets/:tid/messages',
        desc: 'apiDocs.ep.ticketReply',
        params: [pathId('tid', 'apiDocs.p.ticketId'), { name: 'content', in: 'body', type: 'string', required: true, desc: 'apiDocs.p.ticketContent' }, { name: 'close', in: 'body', type: 'boolean', desc: 'apiDocs.p.ticketClose' }],
        body: { content: 'Thanks, it works now.' },
      },
      {
        method: 'PATCH',
        path: '/tickets/:tid',
        desc: 'apiDocs.ep.ticketStatus',
        params: [pathId('tid', 'apiDocs.p.ticketId'), { name: 'status', in: 'body', type: '"OPEN" | "CLOSED"', required: true, desc: 'apiDocs.p.ticketStatusSet' }],
        body: { status: 'CLOSED' },
      },
    ],
  },
  {
    id: 'terminal',
    title: 'apiDocs.g.terminal',
    endpoints: [
      {
        method: 'WS',
        path: '/instances/:id/terminal',
        desc: 'apiDocs.ep.terminal',
        params: [
          ID,
          { name: 'cols', in: 'query', type: 'number', desc: 'apiDocs.p.cols' },
          { name: 'rows', in: 'query', type: 'number', desc: 'apiDocs.p.rows' },
        ],
        returns: 'apiDocs.r.terminal',
      },
    ],
  },
];

// 只读接口绿色，修改类按影响程度区分
const METHOD_TONE: Record<Method, Tone> = { GET: 'success', POST: 'primary', PUT: 'warning', PATCH: 'warning', DELETE: 'danger', WS: 'neutral' };

/** 路径参数替换为示例值，用于 curl */
const samplePath = (path: string) => path.replace(':no', 'P202610250001').replace(/:(\w+)/g, (_, name: string) => (name === 'id' || name === 'instanceId' ? '1' : '2'));

function curlFor(ep: Endpoint, origin: string, token: string): string {
  const url = `${origin}/api${samplePath(ep.path)}`;
  const auth = `-H "Authorization: Bearer ${token}"`;
  if (ep.method === 'WS') return `websocat -H "Authorization: Bearer ${token}" "${url.replace(/^http/, 'ws')}?cols=120&rows=32"`;
  const query = ep.query ?? (ep.params?.some((p) => p.in === 'query' && p.name === 'page') ? '?page=1&pageSize=20' : ep.params?.some((p) => p.name === 'minutes') ? '?minutes=60' : '');
  if (ep.method === 'GET') return `curl ${auth} "${url}${query}"`;
  const body = ep.body ? ` \\\n  -H "Content-Type: application/json" -d '${JSON.stringify(ep.body)}'` : '';
  return `curl -X ${ep.method} ${auth}${body} \\\n  "${url}"`;
}

function MethodTag({ method }: { method: Method }) {
  return <Tag tone={METHOD_TONE[method]} className="w-14 justify-center font-mono">{method}</Tag>;
}

/** 单个接口：折叠时显示方法、路径与说明，展开后显示参数与示例 */
function EndpointRow({ ep, origin }: { ep: Endpoint; origin: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line last:border-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 sm:px-5">
        <MethodTag method={ep.method} />
        <code className="min-w-0 shrink-0 font-mono text-[13px] text-fg" translate="no">
          {ep.path.split(/(:\w+)/).map((part, i) => (part.startsWith(':') ? <span key={i} className="text-fg-3">{part}</span> : part))}
        </code>
        <span className="hidden min-w-0 flex-1 truncate text-[13px] text-fg-3 md:block">{t(ep.desc)}</span>
        <ChevronRight className={cn('ml-auto size-4 shrink-0 text-fg-4 transition-transform duration-200', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="space-y-4 px-4 pb-4 sm:px-5">
          {/* 宽屏时说明已显示在标题行 */}
          <p className="text-[13px] leading-relaxed text-fg-2 md:hidden">{t(ep.desc)}</p>
          {ep.params && ep.params.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-[13px]">
                <thead className="bg-surface-2 text-left text-xs text-fg-3">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('apiDocs.col.param')}</th>
                    <th className="px-3 py-2 font-medium">{t('apiDocs.col.type')}</th>
                    <th className="px-3 py-2 font-medium">{t('apiDocs.col.desc')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ep.params.map((p) => (
                    <tr key={`${p.in}-${p.name}`} className="border-t border-line align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <code className="font-mono text-fg">{p.name}</code>
                        {p.required && <span className="ml-1 text-danger-text">*</span>}
                        <div className="text-[11px] text-fg-4">{t(`apiDocs.in.${p.in}`)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <code className="font-mono text-xs text-fg-2">{p.type}</code>
                      </td>
                      <td className="px-3 py-2 leading-relaxed text-fg-2">{t(p.desc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <div className="mb-1.5 text-xs font-medium text-fg-3">{t('apiDocs.example')}</div>
            <CodeBlock value={curlFor(ep, origin, t('apiDocs.tokenPlaceholder'))} />
          </div>
          {ep.returns && (
            <p className="text-[13px] text-fg-3">
              <span className="font-medium text-fg-2">{t('apiDocs.returns')}：</span>
              {t(ep.returns)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_CODES: [number, MessageKey][] = [
  [400, 'apiDocs.code.400'],
  [401, 'apiDocs.code.401'],
  [402, 'apiDocs.code.402'],
  [403, 'apiDocs.code.403'],
  [404, 'apiDocs.code.404'],
  [409, 'apiDocs.code.409'],
  [429, 'apiDocs.code.429'],
  [502, 'apiDocs.code.502'],
];

export default function ApiDocs() {
  const { t } = useI18n();
  const origin = window.location.origin;
  const token = t('apiDocs.tokenPlaceholder');
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({ ...g, endpoints: g.endpoints.filter((e) => `${e.method} ${e.path} ${t(e.desc)}`.toLowerCase().includes(q)) })).filter((g) => g.endpoints.length > 0);
  }, [query, t]);

  return (
    <>
      <PageHeader
        back={{ to: '/console/account?tab=tokens', label: t('apiDocs.manageTokens') }}
        title={t('apiDocs.title')}
        description={t('apiDocs.desc')}
        actions={
          <LinkButton to="/console/account?tab=tokens" icon={<KeyRound />}>
            {t('apiDocs.manageTokens')}
          </LinkButton>
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* 目录：宽屏吸附在左侧 */}
        <nav className="hidden text-[13px] lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:block" aria-label={t('apiDocs.toc')}>
          <div className="mb-2 px-2 text-xs text-fg-4">{t('apiDocs.toc')}</div>
          {[
            { id: 'quick', title: t('apiDocs.quick') },
            { id: 'conventions', title: t('apiDocs.conventions') },
            ...GROUPS.map((g) => ({ id: g.id, title: t(g.title), count: g.endpoints.length })),
          ].map((s) => (
            <a key={s.id} href={`#${s.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg">
              {s.title}
              {'count' in s && <span className="tabular text-xs text-fg-4">{s.count}</span>}
            </a>
          ))}
        </nav>

        <div className="min-w-0 space-y-6">
          {/* 快速开始 */}
          <Card id="quick" className="scroll-mt-24">
            <div className="space-y-4 p-4 sm:p-5">
              <h2 className="text-[15px] font-semibold">{t('apiDocs.quick')}</h2>
              <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-fg-2">
                <li>{t('apiDocs.quick.step1')}</li>
                <li>{t('apiDocs.quick.step2')}</li>
                <li>{t('apiDocs.quick.step3')}</li>
              </ol>
              <div>
                <div className="mb-1.5 text-xs font-medium text-fg-3">{t('apiDocs.baseUrl')}</div>
                <CodeBlock value={`${origin}/api`} />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-fg-3">{t('apiDocs.example')}</div>
                <CodeBlock value={`curl -H "Authorization: Bearer ${token}" ${origin}/api/instances`} />
              </div>
            </div>
          </Card>

          {/* 请求与响应约定 */}
          <Card id="conventions" className="scroll-mt-24">
            <div className="space-y-4 p-4 sm:p-5">
              <h2 className="text-[15px] font-semibold">{t('apiDocs.conventions')}</h2>
              <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-fg-2">
                <li>{t('apiDocs.conv.json')}</li>
                <li>{t('apiDocs.conv.async')}</li>
                <li>{t('apiDocs.conv.paging')}</li>
                <li>{t('apiDocs.conv.error')}</li>
              </ul>
              <CodeBlock value={`{\n  "error": "VALIDATION",\n  "message": "${t('apiDocs.conv.errorSample')}",\n  "details": [{ "path": "action", "message": "${t('apiDocs.conv.errorSample')}" }]\n}`} />
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-surface-2 text-left text-xs text-fg-3">
                    <tr>
                      <th className="w-24 px-3 py-2 font-medium">{t('apiDocs.col.status')}</th>
                      <th className="px-3 py-2 font-medium">{t('apiDocs.col.meaning')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STATUS_CODES.map(([code, key]) => (
                      <tr key={code} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-fg">{code}</td>
                        <td className="px-3 py-2 text-fg-2">{t(key)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          {/* 接口列表 */}
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-4" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('apiDocs.search')} className="pl-9" aria-label={t('apiDocs.search')} />
          </div>
          {groups.length === 0 ? (
            <Card>
              <Empty icon={<Search />} title={t('apiDocs.noMatch')} />
            </Card>
          ) : (
            groups.map((g) => (
              <section key={g.id} id={g.id} className="scroll-mt-24">
                <h2 className="mb-2.5 text-[15px] font-semibold">{t(g.title)}</h2>
                <Card className="overflow-hidden">
                  {g.endpoints.map((ep) => (
                    <EndpointRow key={`${ep.method} ${ep.path}`} ep={ep} origin={origin} />
                  ))}
                </Card>
                {g.id === 'terminal' && (
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-fg-3">
                    <li>{t('apiDocs.ws.send')}</li>
                    <li>{t('apiDocs.ws.recv')}</li>
                  </ul>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}
