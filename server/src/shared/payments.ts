/**
 * 支付渠道：易支付（支付宝 / 微信 / QQ 钱包，人民币）、Stripe（银行卡等）、Heleket（加密货币），每种都可以配置多个渠道。
 * 手续费 = 充值金额 × 费率 + 固定费用（向上取到分），加在应付金额上，到账余额仍是充值金额。
 * 计价货币不是 CNY 的渠道按实时汇率换算实际收取的外币金额。
 */
export const PAY_CHANNEL_TYPES = ['epay', 'stripe', 'heleket'] as const;
export type PayChannelType = (typeof PAY_CHANNEL_TYPES)[number];

export const EPAY_METHODS = ['alipay', 'wxpay', 'qqpay'] as const;
export type EpayMethod = (typeof EPAY_METHODS)[number];

/** Stripe 没有小数位的货币：金额直接是最小单位（其余按分 ×100） */
export const ZERO_DECIMAL_CURRENCIES = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];

interface PayChannelBaseDTO {
  id: string;
  name: string;
  enabled: boolean;
  /** 数字小的排在前面 */
  sort: number;
  minAmount: number;
  /** 0 = 不限 */
  maxAmount: number;
  /** 每笔固定费用（元），与费率叠加 */
  feeFixed: number;
}

/** 管理端看到的渠道：密钥不返回，只标出是否已配置 */
export interface EpayChannelDTO extends PayChannelBaseDTO {
  type: 'epay';
  /** 接口版本：v1 = MD5 签名；v2 = RSA 签名 */
  version: 'v1' | 'v2';
  /** 下单方式：submit = 页面跳转；api = 服务端调用接口，返回支付链接或二维码 */
  mode: 'submit' | 'api';
  apiUrl: string;
  pid: string;
  platformPublicKey: string;
  methods: Array<{ method: EpayMethod; enabled: boolean; feePercent: number }>;
  hasKey: boolean;
  hasPrivateKey: boolean;
}

export interface StripeChannelDTO extends PayChannelBaseDTO {
  type: 'stripe';
  feePercent: number;
  currency: string;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
}

export interface HeleketChannelDTO extends PayChannelBaseDTO {
  type: 'heleket';
  feePercent: number;
  currency: string;
  merchantId: string;
  /** 发票有效期（秒） */
  lifetime: number;
  hasApiKey: boolean;
}

export type PayChannelDTO = EpayChannelDTO | StripeChannelDTO | HeleketChannelDTO;

/** 管理端支付渠道列表，附带回调地址（Stripe 的需要填到 Stripe 后台） */
export interface PayChannelsViewDTO {
  channels: PayChannelDTO[];
  urls: { epayNotify: string; stripeWebhook: string; heleketNotify: string };
}

/** 用户可选的一种支付方式：易支付渠道每种启用的支付方式一项，Stripe / Heleket 每个渠道一项 */
export interface PayOptionDTO {
  channelId: string;
  /** alipay / wxpay / qqpay / stripe / heleket */
  method: string;
  label: string;
  feePercent: number;
  feeFixed: number;
  minAmount: number;
  /** 0 = 不限 */
  maxAmount: number;
  /** 计价货币和 1 元人民币折合多少（前端显示“约合”；还没取到实时汇率时 rate 为 null） */
  currency: string;
  rate: number | null;
}

export interface PayOptionsDTO {
  enabled: boolean;
  options: PayOptionDTO[];
}

/** 发起支付后前端要执行的动作：跳转 / 提交表单 / 显示二维码 / 显示网关返回的页面 */
export type PayActionDTO =
  | { kind: 'redirect'; url: string }
  | { kind: 'form'; action: string; fields: Record<string, string> }
  | { kind: 'qrcode'; content: string }
  | { kind: 'html'; html: string };

export interface CreatePaymentResultDTO {
  no: string;
  amount: string;
  fee: string;
  action: PayActionDTO;
}
