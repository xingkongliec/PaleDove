-- 宿主机：购买需实名、可用镜像列表
ALTER TABLE "Node" ADD COLUMN "requireRealName" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Node" ADD COLUMN "imageIds" JSONB;
