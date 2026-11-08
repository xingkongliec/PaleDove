-- API 令牌：只读权限
ALTER TABLE "ApiToken" ADD COLUMN "readOnly" BOOLEAN NOT NULL DEFAULT false;
