import { BILLING_CYCLES, hasIpv6Mode, isVmType, productNodeOption, scaleTraffic, type AdminPlanDTO, type AdminProductDTO, type BillingCycle, type NodeDTO } from '../../../shared/index';

/** 管理员按套餐开通时，沿用套餐规格和产品在当前宿主机上的配置。 */
export function instancePlanDefaults(
  plan: AdminPlanDTO,
  cycle: BillingCycle,
  node: Pick<NodeDTO, 'id' | 'networkMode'>,
  product?: Pick<AdminProductDTO, 'nodeOptions' | 'privileged' | 'nesting'>,
) {
  const cycles = BILLING_CYCLES.filter((c) => plan.prices[c] != null);
  const billingCycle = cycles.includes(cycle) ? cycle : cycles[0] ?? cycle;
  const nodeOptions = productNodeOption(product?.nodeOptions, node.id);
  return {
    planId: plan.id,
    type: plan.type,
    cpu: plan.cpu,
    cpuAllowance: plan.cpuAllowance,
    cpuPriority: plan.cpuPriority,
    processLimit: isVmType(plan.type) ? null : plan.processLimit,
    memory: plan.memory,
    swap: isVmType(plan.type) ? 0 : plan.swap,
    disk: plan.disk,
    diskRead: plan.diskRead,
    diskWrite: plan.diskWrite,
    diskReadIops: plan.diskReadIops,
    diskWriteIops: plan.diskWriteIops,
    bandwidthIn: plan.bandwidthIn,
    bandwidthOut: plan.bandwidthOut,
    traffic: scaleTraffic(plan.traffic, nodeOptions.trafficMultiplier),
    trafficMode: plan.trafficMode,
    overLimitAction: plan.overLimitAction,
    throttleRate: plan.throttleRate,
    trafficResetPrice: plan.trafficResetPrice,
    portLimit: plan.type === 'KVM_IPV4' ? 0 : plan.portLimit,
    siteLimit: plan.type === 'KVM_IPV4' ? 0 : plan.siteLimit,
    snapshotLimit: plan.snapshotLimit,
    storagePool: nodeOptions.storagePool ?? plan.storagePool ?? '',
    ipv6Count: hasIpv6Mode(node.networkMode) ? Math.max(node.networkMode === 'IPV6_ONLY' ? 1 : 0, plan.ipv6Count) : 0,
    privileged: plan.type === 'LXC_NAT' && (product?.privileged ?? false),
    nesting: product?.nesting ?? true,
    billingCycle,
    price: plan.prices[billingCycle] ?? '0',
  };
}
