-- 用户头像风格（DiceBear），默认「开怀大笑」
ALTER TABLE "User" ADD COLUMN "avatarStyle" TEXT NOT NULL DEFAULT 'bigSmile';
-- 头像形象编号
ALTER TABLE "User" ADD COLUMN "avatarVariant" INTEGER NOT NULL DEFAULT 0;
