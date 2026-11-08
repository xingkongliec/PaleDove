-- 节点测试：由宿主机 Agent 每小时 Ping 国内三网目标
ALTER TABLE "Node" ADD COLUMN "pingEnabled" BOOLEAN NOT NULL DEFAULT false;
