-- 宿主机公告：显示在该宿主机上全部实例的实例管理页面
ALTER TABLE "Node" ADD COLUMN "announcement" TEXT NOT NULL DEFAULT '';
