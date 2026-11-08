// 头像（参考 incudal）：由 DiceBear 按种子生成，用户可在账户设置里选择风格；API 地址由管理员在系统设置中配置。
// 种子为邮箱的 md5（服务端计算后下发），同一用户的头像保持不变，也不会把明文邮箱发给第三方。

export const DEFAULT_AVATAR_API = 'https://api.dicebear.com/9.x';

/**
 * 头像风格（键名 → DiceBear 风格名），一律使用透明背景。
 * 不收录去掉底色后不完整或仍是方块的风格：带肤色底的「纯净」版、趣味表情、首字母、几何图形、毛玻璃
 */
export const AVATAR_STYLE_NAMES = {
  adventurer: 'adventurer',
  avataaars: 'avataaars',
  bigEars: 'big-ears',
  bigSmile: 'big-smile',
  bottts: 'bottts',
  croodles: 'croodles',
  croodlesNeutral: 'croodles-neutral',
  dylan: 'dylan',
  icons: 'icons',
  identicon: 'identicon',
  lorelei: 'lorelei',
  loreleiNeutral: 'lorelei-neutral',
  micah: 'micah',
  miniavs: 'miniavs',
  notionists: 'notionists',
  notionistsNeutral: 'notionists-neutral',
  openPeeps: 'open-peeps',
  personas: 'personas',
  pixelArt: 'pixel-art',
  rings: 'rings',
  thumbs: 'thumbs',
} as const;
export type AvatarStyle = keyof typeof AVATAR_STYLE_NAMES;
export const AVATAR_STYLES = Object.keys(AVATAR_STYLE_NAMES) as AvatarStyle[];
export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'bigSmile';

export const isAvatarStyle = (v: unknown): v is AvatarStyle => typeof v === 'string' && Object.prototype.hasOwnProperty.call(AVATAR_STYLE_NAMES, v);

/** 每个用户可选的形象数量（形象编号 0 ~ AVATAR_VARIANTS - 1） */
export const AVATAR_VARIANTS = 1000;

/** 用户头像信息：风格、种子（邮箱 md5）与形象编号；同一风格下不同编号生成不同的形象 */
export interface AvatarDTO {
  style: AvatarStyle;
  seed: string;
  variant: number;
}

/** 头像地址；API 地址为空时返回 null（显示首字母） */
export function avatarUrl(apiBase: string | null | undefined, avatar: AvatarDTO | null | undefined, size = 64): string | null {
  const base = (apiBase ?? DEFAULT_AVATAR_API).trim().replace(/\/+$/, '');
  if (!base || !avatar?.seed) return null;
  const style = AVATAR_STYLE_NAMES[isAvatarStyle(avatar.style) ? avatar.style : DEFAULT_AVATAR_STYLE];
  // 透明背景：头像不带方形底色
  const seed = avatar.variant ? `${avatar.seed}-${avatar.variant}` : avatar.seed;
  return `${base}/${style}/svg?seed=${encodeURIComponent(seed)}&size=${Math.max(16, Math.min(256, Math.round(size)))}&backgroundColor=transparent`;
}
