import { describe, expect, it } from 'vitest';
import type { AdminPlanDTO } from '../src/shared/index.ts';
import { instancePlanDefaults } from '../../web/src/pages/admin/instances/instance-create-plan';

const plan: AdminPlanDTO = {
  id: 3, productId: 2, name: 'Small', description: null, type: 'LXC_NAT',
  cpu: 2, cpuAllowance: 50, cpuPriority: 0, processLimit: 512,
  memory: 1024, swap: 256, disk: 20, diskRead: 0, diskWrite: 50, diskReadIops: 200, diskWriteIops: 0,
  bandwidthIn: 200, bandwidthOut: 100, traffic: 100, trafficMode: 'OUT',
  overLimitAction: 'THROTTLE', throttleRate: 2, trafficResetPrice: '3.50',
  portLimit: 10, siteLimit: 2, snapshotLimit: 3, storagePool: 'slow', ipv6Count: 2,
  prices: { QUARTERLY: '15.00', ANNUAL: '50.00' },
  stockLeft: null, regions: [], regionInfo: {}, stock: null, enabled: true, sortOrder: 0, activeInstances: 0,
};
const node = { id: 9, networkMode: 'NAT' as const };

describe('admin instance plan defaults', () => {
  it('copies resource limits and switches to a supported billing cycle and price', () => {
    const defaults = instancePlanDefaults(plan, 'MONTHLY', node);
    expect(defaults).toMatchObject({
      planId: plan.id, type: 'LXC_NAT', cpu: 2, cpuAllowance: 50, cpuPriority: 0, processLimit: 512,
      memory: 1024, swap: 256, disk: 20, diskReadIops: 200, diskWrite: 50,
      bandwidthIn: 200, bandwidthOut: 100, traffic: 100, trafficResetPrice: '3.50',
      snapshotLimit: 3, storagePool: 'slow', billingCycle: 'QUARTERLY', price: '15.00', ipv6Count: 0,
    });
    expect(instancePlanDefaults(plan, 'ANNUAL', node)).toMatchObject({ billingCycle: 'ANNUAL', price: '50.00' });
  });

  it('inherits product container settings and host-specific traffic and storage options', () => {
    expect(instancePlanDefaults(plan, 'ANNUAL', node, {
      privileged: true, nesting: false, nodeOptions: { [node.id]: { trafficMultiplier: 1.5, storagePool: 'fast' } },
    })).toMatchObject({ traffic: 150, storagePool: 'fast', privileged: true, nesting: false });
    expect(instancePlanDefaults(plan, 'ANNUAL', node, {
      privileged: false, nesting: true, nodeOptions: { 99: { trafficMultiplier: 2, storagePool: 'elsewhere' } },
    })).toMatchObject({ traffic: 100, storagePool: 'slow' });
  });

  it('preserves unlimited traffic and never rounds limited traffic down to unlimited', () => {
    const product = { privileged: false, nesting: true, nodeOptions: { [node.id]: { trafficMultiplier: 0.1, storagePool: null } } };
    expect(instancePlanDefaults({ ...plan, traffic: 0 }, 'ANNUAL', node, product).traffic).toBe(0);
    expect(instancePlanDefaults({ ...plan, traffic: 1 }, 'ANNUAL', node, product).traffic).toBe(1);
  });

  it('matches IPv6 allocation to the host and keeps IPv6-only instances reachable', () => {
    expect(instancePlanDefaults(plan, 'ANNUAL', { ...node, networkMode: 'NAT_IPV6' }).ipv6Count).toBe(2);
    expect(instancePlanDefaults({ ...plan, ipv6Count: 0 }, 'ANNUAL', { ...node, networkMode: 'IPV6_ONLY' }).ipv6Count).toBe(1);
    expect(instancePlanDefaults(plan, 'ANNUAL', node).ipv6Count).toBe(0);
  });

  it('normalizes virtual-machine and dedicated-IPv4 fields', () => {
    expect(instancePlanDefaults({ ...plan, type: 'KVM_IPV4' }, 'ANNUAL', { ...node, networkMode: 'IPV4' })).toMatchObject({
      type: 'KVM_IPV4', swap: 0, processLimit: null, portLimit: 0, siteLimit: 0, privileged: false, ipv6Count: 0,
    });
  });

  it('does not retain a previous price or storage pool when the next plan has none', () => {
    expect(instancePlanDefaults({ ...plan, prices: {}, storagePool: null }, 'ANNUAL', node)).toMatchObject({
      billingCycle: 'ANNUAL', price: '0', storagePool: '',
    });
    expect(instancePlanDefaults({ ...plan, prices: { MONTHLY: '0.00' } }, 'ANNUAL', node)).toMatchObject({
      billingCycle: 'MONTHLY', price: '0.00',
    });
  });
});
