import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PingResultDTO } from '../src/shared/index.ts';

const mocks = vi.hoisted(() => ({ find: vi.fn(), report: vi.fn() }));
vi.mock('../src/lib/prisma.ts', () => ({ prisma: { instance: { findUnique: mocks.find, findUniqueOrThrow: mocks.find } } }));
vi.mock('../src/services/agent/agent.ts', () => ({ getHostReport: mocks.report }));
vi.mock('../src/lib/redis.ts', async () => {
  const { MemoryRedis } = await import('../src/lib/memory-redis.ts');
  return { redis: new MemoryRedis(), withLock: async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn() };
});
import { agentIpv4Checks, checkIpv4, saveAgentIpv4Check } from '../src/services/agent/ipv4-check.ts';

let sequence = 0;
const fixture = () => ({
  id: ++sequence, nodeId: 101, type: 'KVM_NAT', status: 'RUNNING', macAddress: '00:16:3e:00:01:02',
  ipAddress: null as { address: string; gateway: string } | null,
  node: { id: 101, endpoint: 'mock://ipv4-check', publicIp: '203.0.113.10', networkMode: 'NAT', publicNicMode: 'ROUTED', publicNicParent: null as string | null },
});
let inst: ReturnType<typeof fixture>;
const results = (reachable = true): PingResultDTO[] => ['bj-ct', 'bj-cu', 'sh-cu', 'sh-cm', 'gd-ct', 'gd-cm'].map((id) => ({ id, latency: reachable ? 25 : null, loss: reachable ? 0 : 100 }));
const currentJob = async () => (await agentIpv4Checks(101)).find((j) => j.id === inst.id)!;
const finish = async (data: Partial<Parameters<typeof saveAgentIpv4Check>[1]> = {}) => {
  const job = await currentJob();
  return saveAgentIpv4Check(101, { id: inst.id, requestId: job.requestId, method: 'icmp', via: 'local', results: results(), ...data });
};

describe('on-demand agent IPv4 check', () => {
  beforeEach(() => {
    inst = fixture();
    mocks.find.mockImplementation(async ({ where }: { where: { id: number } }) => where.id === inst.id ? structuredClone(inst) : null);
    mocks.report.mockResolvedValue({ online: true, capabilities: ['ipv4-check'] });
  });
  afterEach(() => vi.restoreAllMocks());

  it('tests a stopped NAT instance from the host IPv4 without executing guest commands or reading old node tests', async () => {
    inst.status = 'STOPPED';
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'pending', method: null, ipv4: inst.node.publicIp });
    const job = await currentJob();
    expect(job).toMatchObject({ id: inst.id, ip: inst.node.publicIp, kind: 'nat' });
    expect(job.targets.map((t) => t.id)).toEqual(results().map((r) => r.id));
    expect(await finish()).toBe(true);
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'ok', method: 'icmp', reachable: 6, total: 6, reason: null });
    expect(await agentIpv4Checks(101)).toEqual([]);
  });

  it.each(['ROUTED', 'BRIDGED'])('uses the dedicated instance address with %s networking', async (mode) => {
    inst.type = 'KVM_IPV4'; inst.node.networkMode = 'IPV4'; inst.node.publicNicMode = mode;
    inst.node.publicNicParent = mode === 'BRIDGED' ? 'br0' : null;
    inst.ipAddress = { address: '198.51.100.20', gateway: '198.51.100.1' };
    await checkIpv4(inst.id);
    const job = await currentJob();
    expect(job).toMatchObject({ kind: 'dedicated', ip: '198.51.100.20' });
    expect(job.ip).not.toBe(inst.node.publicIp);
    if (mode === 'BRIDGED') expect(job).toMatchObject({ bridge: 'br0', mac: inst.macAddress, gateway: inst.ipAddress.gateway });
    else expect(job.bridge).toBeUndefined();
    await finish({ via: mode === 'BRIDGED' ? 'spoof-l2' : 'spoof' });
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'ok', method: 'icmp', ipv4: '198.51.100.20' });
  });

  it('rejects the host default source as proof of dedicated IPv4 connectivity', async () => {
    inst.type = 'KVM_IPV4'; inst.ipAddress = { address: '198.51.100.20', gateway: '198.51.100.1' };
    await checkIpv4(inst.id);
    await finish({ via: 'default' });
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'unknown', method: null, reason: 'error' });
  });

  it('only marks complete ICMP timeouts as blocked', async () => {
    await checkIpv4(inst.id);
    await finish({ results: results(false) });
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'blocked', reachable: 0, total: 6 });
    for (const partial of [results(false).slice(1), Array(6).fill(results(false)[0]), results(false).map((r, i) => ({ ...r, ...(i === 0 ? { error: 'DNS failed' } : {}) }))]) {
      await checkIpv4(inst.id, true);
      await finish({ results: partial });
      expect((await checkIpv4(inst.id)).status).toBe('unknown');
    }
  });

  it('reports agent errors and TCP fallbacks as unknown instead of blocked or reachable', async () => {
    for (const input of [{ error: 'permission denied' }, { method: 'tcp' as 'icmp' }]) {
      await checkIpv4(inst.id, true);
      await finish(input);
      expect(await checkIpv4(inst.id)).toMatchObject({ status: 'unknown', method: null, reason: 'error' });
    }
  });

  it('coalesces pending checks, creates a new request for rechecks, and ignores foreign or late replies', async () => {
    await checkIpv4(inst.id);
    const first = await currentJob();
    await checkIpv4(inst.id, true);
    expect((await currentJob()).requestId).toBe(first.requestId);
    expect(await saveAgentIpv4Check(202, { id: inst.id, requestId: first.requestId, method: 'icmp', results: results() })).toBe(false);
    await finish();
    await checkIpv4(inst.id, true);
    const second = await currentJob();
    expect(second.requestId).not.toBe(first.requestId);
    expect(await saveAgentIpv4Check(101, { id: inst.id, requestId: first.requestId, method: 'icmp', results: results(false) })).toBe(false);
    expect((await checkIpv4(inst.id)).status).toBe('pending');
  });

  it('expires pending work and allows a new check after timeout', async () => {
    await checkIpv4(inst.id);
    const first = await currentJob();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 91_000);
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'unknown', reason: 'timeout' });
    expect(await agentIpv4Checks(101)).toEqual([]);
    await checkIpv4(inst.id, true);
    expect((await currentJob()).requestId).not.toBe(first.requestId);
  });

  it('invalidates old results and pending jobs when the instance IP or host changes', async () => {
    await checkIpv4(inst.id);
    const old = await currentJob();
    inst.node.publicIp = '203.0.113.99';
    expect(await agentIpv4Checks(101)).toEqual([]);
    expect(await saveAgentIpv4Check(101, { id: inst.id, requestId: old.requestId, method: 'icmp', results: results() })).toBe(false);
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'pending', ipv4: '203.0.113.99' });
    await finish();
    inst.nodeId = 202; inst.node.id = 202;
    expect((await checkIpv4(inst.id)).status).toBe('pending');
    expect(await agentIpv4Checks(101)).toEqual([]);
    expect(await agentIpv4Checks(202)).toHaveLength(1);
  });

  it('does not label a powered-off dedicated instance as blocked or change its power state', async () => {
    inst.type = 'KVM_IPV4'; inst.status = 'STOPPED'; inst.ipAddress = { address: '198.51.100.20', gateway: '198.51.100.1' };
    await checkIpv4(inst.id);
    await finish({ via: 'spoof', results: results(false) });
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'unknown', reason: 'notRunning' });
    expect(inst.status).toBe('STOPPED');
    inst.status = 'RUNNING';
    expect((await checkIpv4(inst.id)).status).toBe('pending');
  });

  it('explains unavailable agents and IPv6-only instances without queuing a test', async () => {
    mocks.report.mockResolvedValue(null);
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'unknown', reason: 'agentOffline' });
    mocks.report.mockResolvedValue({ online: true, capabilities: ['node-test', 'listing-ping'] });
    expect(await checkIpv4(inst.id, true)).toMatchObject({ status: 'unknown', reason: 'agentUpgrade' });
    inst.node.networkMode = 'IPV6_ONLY';
    expect(await checkIpv4(inst.id)).toMatchObject({ status: 'unknown', reason: 'noIpv4' });
    expect(await agentIpv4Checks(101)).toEqual([]);
  });
});
