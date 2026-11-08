-- 管理员自定义实例进程审查规则库
CREATE TABLE "InstanceAuditRule" (
    "id" SERIAL NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "matches" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceAuditRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstanceAuditRule_ruleKey_key" ON "InstanceAuditRule"("ruleKey");
CREATE INDEX "InstanceAuditRule_enabled_idx" ON "InstanceAuditRule"("enabled");
