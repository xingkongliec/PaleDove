// 用户头像：按用户选择的风格从 DiceBear 生成，直接显示图片（不加圆形边框和背景）；
// 未配置头像 API、缺少头像信息或加载失败时显示名称首字母
import { useState } from 'react';
import { avatarUrl, type AvatarDTO } from '../shared/index';
import { cn } from '@/lib/cn';
import { usePublicConfig } from '@/lib/queries';

export function UserAvatar({ avatar, name, size = 32, className }: { avatar: AvatarDTO | null | undefined; name: string; size?: number; className?: string }) {
  const { data: cfg } = usePublicConfig();
  // 高分屏下用两倍尺寸的图片
  const src = avatarUrl(cfg?.avatarApiBase, avatar, size * 2);
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size };
  if (src && failed !== src) {
    return <img src={src} alt={name} loading="lazy" draggable={false} onError={() => setFailed(src)} style={style} className={cn('shrink-0 object-contain', className)} />;
  }
  return (
    <span
      style={{ ...style, fontSize: Math.max(10, Math.round(size * 0.38)) }}
      className={cn('flex shrink-0 items-center justify-center font-semibold text-fg-2 uppercase select-none', className)}
      aria-label={name}
    >
      {name.slice(0, size >= 28 ? 2 : 1)}
    </span>
  );
}
