-- 用户切换机房：任务类型、余额流水类型与实例上的切换时间
ALTER TYPE "TaskType" ADD VALUE 'SWITCH_NODE';
ALTER TYPE "BalanceLogType" ADD VALUE 'SWITCH';
ALTER TABLE "Instance" ADD COLUMN "freeSwitchAt" TIMESTAMP(3), ADD COLUMN "nodeSwitchedAt" TIMESTAMP(3);
