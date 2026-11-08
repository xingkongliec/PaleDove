import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { IncusInstance, IncusNetworkLease } from '../src/incus/types.ts';

describe('private IP allocation and failed provisioning recovery', () => {
  let directory: string;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let allocation: typeof import('../src/services/allocation.ts');
  let recovery: typeof import('../src/services/provisioning-network.ts');
  let place: typeof import('../src/services/migration.ts').place;
  let runTask: typeof import('../src/services/operations.ts').runTask;
  let getIncus: typeof import('../src/incus/index.ts').getIncus;
  let userId: number;
  let imageId: number;
  let sequence = 0;

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-private-ip-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-private-ip-secret-1234567890', LOG_LEVEL: 'error' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    allocation = await import('../src/services/allocation.ts');
    recovery = await import('../src/services/provisioning-network.ts');
    ({ place } = await import('../src/services/migration.ts'));
    ({ runTask } = await import('../src/services/operations.ts'));
    ({ getIncus } = await import('../src/incus/index.ts'));
    userId = (await db.user.create({ data: { username: 'ip-owner', email: 'ip@example.com', passwordHash: 'unused' } })).id;
    imageId = (await db.image.create({ data: { name: 'Debian', family: 'debian', alias: 'debian/12', server: 'https://images.example.com', protocol: 'simplestreams' } })).id;
  }, 90_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-private-ip-test-')) rmSync(directory, { recursive: true, force: true });
  });

  const lease = (address: string, over: Partial<IncusNetworkLease> = {}): IncusNetworkLease => ({ hostname: 'external-instance', address, hwaddr: '00:16:3e:ff:ff:01', type: 'static', ...over });
  const collision = (ip: string) => new Error(`Failed start validation for device "eth0": IP address "${ip}" already defined on another NIC`);
  async function fixture() {
    const number = ++sequence;
    const node = await db.node.create({ data: { name: `IP node ${number}`, region: 'Test', endpoint: `mock://private-ip-${number}`, publicIp: '203.0.113.30', status: 'ONLINE', natCidr: '10.88.0.1/16' } });
    const inst = await db.instance.create({ data: {
      name: `ip-instance-${number}`, hostname: `ip-instance-${number}`, userId, imageId, nodeId: node.id, type: 'LXC_NAT', status: 'ERROR', privateIp: '10.88.255.254', macAddress: '00:16:3e:00:00:10',
      cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 100, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 1,
      portLimit: 5, siteLimit: 5, snapshotLimit: 5, trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY', price: 5, expiresAt: new Date(Date.now() + 86400_000),
    }, include: { node: true, image: true, ipAddress: true, portMappings: true } });
    const incus = await getIncus(node);
    return { node, inst, incus };
  }

  it('reserves stopped/profile NICs, DHCP leases and DB-only pending instances together', async () => {
    const { node, inst, incus } = await fixture();
    await db.instance.update({ where: { id: inst.id }, data: { privateIp: '10.88.255.252', status: 'CREATING' } });
    const query = vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([
      lease('10.88.255.254'), lease('10.88.255.253', { type: 'dynamic' }), lease('fd42::1'),
    ]);
    const hostIps = await allocation.hostPrivateIps(node);
    expect(query).toHaveBeenCalledWith(node.natNetwork);
    expect([...hostIps]).toEqual(['10.88.255.254', '10.88.255.253']);
    expect(await db.$transaction((tx) => allocation.allocatePrivateIp(tx, node, hostIps))).toBe('10.88.255.251');
  });

  it('includes stopped, inherited and parent-attached NIC reservations in the mock API', async () => {
    const { node, incus } = await fixture();
    vi.spyOn(incus, 'listInstances').mockResolvedValue([{
      name: 'stopped-external', type: 'container', config: {}, devices: {}, status: 'Stopped', status_code: 102, state: null,
      description: '', architecture: 'x86_64', profiles: ['default'], ephemeral: false, stateful: false, created_at: new Date().toISOString(),
      expanded_devices: { eth0: { type: 'nic', network: node.natNetwork, 'ipv4.address': '10.88.255.254' },
        eth1: { type: 'nic', parent: node.natNetwork, 'ipv4.address': '10.88.255.253' },
        eth2: { type: 'nic', network: 'other-network', 'ipv4.address': '10.88.255.252' } },
    }]);
    const ips = await allocation.hostPrivateIps(node);
    expect(ips.has('10.88.255.254')).toBe(true);
    expect(ips.has('10.88.255.253')).toBe(true);
    expect(ips.has('10.88.255.252')).toBe(false);
  });

  it('fails closed when the host cannot report address reservations', async () => {
    const { node, incus } = await fixture();
    vi.spyOn(incus, 'getNetworkLeases').mockRejectedValue(new Error('Incus unavailable'));
    await expect(allocation.hostPrivateIps(node)).rejects.toThrow('Incus unavailable');
  });

  it('reports subnet exhaustion when the remaining addresses belong to host NICs', async () => {
    const { node } = await fixture();
    node.natCidr = '10.88.0.1/28';
    await expect(allocation.allocatePrivateIp(db, node, new Set(['10.88.0.11', '10.88.0.12', '10.88.0.13', '10.88.0.14']))).rejects.toThrow(/耗盡|耗尽|No private addresses/);
  });

  it('does not preserve a conflicting or out-of-subnet migration address', async () => {
    const { node, inst, incus } = await fixture();
    vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([lease(inst.privateIp!)]);
    const moved = await place(inst, node, { privateIp: inst.privateIp }, false);
    expect(moved.privateIp).toBe('10.88.255.253');
    const other = await place(inst, node, { privateIp: '192.168.1.10' }, false);
    expect(other.privateIp).toBe('10.88.255.253');
  });

  it('preserves its own address during migration rollback, while still respecting other owners', async () => {
    const { node, inst, incus } = await fixture();
    const query = vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([
      lease(inst.privateIp!, { hostname: inst.name, hwaddr: inst.macAddress! }),
      lease(inst.privateIp!, { hostname: inst.name, hwaddr: inst.macAddress!, type: 'dynamic' }),
    ]);
    expect((await place(inst, node, { privateIp: inst.privateIp }, false)).privateIp).toBe(inst.privateIp);
    query.mockResolvedValue([lease(inst.privateIp!, { hostname: inst.name, hwaddr: inst.macAddress! }), lease(inst.privateIp!)]);
    expect((await place(inst, node, { privateIp: inst.privateIp }, false)).privateIp).toBe('10.88.255.253');
  });

  it('repairs an existing failed CREATE and updates both eth0 and proxy destinations', async () => {
    const { inst, incus } = await fixture();
    const mapping = await db.portMapping.create({ data: { instanceId: inst.id, nodeId: inst.nodeId, publicPort: 20022, privatePort: 22, protocol: 'TCP', system: true } });
    const remote = {
      name: inst.name, status: 'Stopped', config: { 'user.paledove.id': String(inst.id) },
      devices: { eth0: { type: 'nic', network: inst.node.natNetwork, 'ipv4.address': inst.privateIp } },
    } as unknown as IncusInstance;
    vi.spyOn(incus, 'instanceExists').mockResolvedValue(true);
    vi.spyOn(incus, 'getInstance').mockImplementation(async () => structuredClone(remote));
    vi.spyOn(incus, 'getInstanceState').mockImplementation(async () => ({ status: remote.status } as Awaited<ReturnType<typeof incus.getInstanceState>>));
    vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([lease(inst.privateIp!)]);
    vi.spyOn(incus, 'modifyInstance').mockImplementation(async (_name, mutate) => { mutate(remote); });
    const start = vi.spyOn(incus, 'setState').mockImplementation(async () => {
      if (remote.devices.eth0['ipv4.address'] === '10.88.255.254') throw collision('10.88.255.254');
      remote.status = 'Running';
    });
    const task = await db.task.create({ data: { instanceId: inst.id, userId, type: 'CREATE' } });
    await runTask(task.id);
    const done = await db.instance.findUniqueOrThrow({ where: { id: inst.id } });
    const taskDone = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(taskDone.status, taskDone.error ?? '').toBe('SUCCESS');
    expect(done).toMatchObject({ privateIp: '10.88.255.253', status: 'RUNNING', lastError: null });
    expect(done.provisionedAt).not.toBeNull();
    expect(remote.devices.eth0['ipv4.address']).toBe(done.privateIp);
    expect(Object.values(remote.devices).some((device) => device.connect === `tcp:${done.privateIp}:${mapping.privatePort}`)).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('skips conflicting addresses reported after the lease snapshot without reusing earlier attempts', async () => {
    const { inst, incus } = await fixture();
    vi.spyOn(incus, 'instanceExists').mockResolvedValue(false);
    vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([]);
    const seen: string[] = [];
    await recovery.withPrivateIpRecovery(inst, incus, async () => {
      seen.push(inst.privateIp!);
      if (seen.length < 3) throw collision(inst.privateIp!);
    });
    expect(seen).toEqual(['10.88.255.254', '10.88.255.253', '10.88.255.252']);
  });

  it('rebuilds a fresh CREATE request when Incus rolls back a failed creation', async () => {
    const { inst, incus } = await fixture();
    const { encrypt } = await import('../src/lib/crypto.ts');
    let remote: IncusInstance | undefined;
    vi.spyOn(incus, 'instanceExists').mockImplementation(async () => !!remote);
    vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([]);
    vi.spyOn(incus, 'modifyInstance').mockImplementation(async (_name, mutate) => { mutate(remote!); });
    const create = vi.spyOn(incus, 'createInstance').mockImplementation(async (req) => {
      if (req.devices.eth0['ipv4.address'] === '10.88.255.254') throw collision('10.88.255.254');
      remote = { ...req, status: 'Running' } as unknown as IncusInstance;
    });
    const task = await db.task.create({ data: { instanceId: inst.id, userId, type: 'CREATE', payload: { password: encrypt('test-password-123') } } });
    await runTask(task.id);
    const done = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(done.status, done.error ?? '').toBe('SUCCESS');
    expect(create.mock.calls.map(([req]) => req.devices.eth0['ipv4.address'])).toEqual(['10.88.255.254', '10.88.255.253']);
    expect((await db.instance.findUniqueOrThrow({ where: { id: inst.id } })).privateIp).toBe('10.88.255.253');
  });

  it('resumes address synchronization after a failed host update without allocating again', async () => {
    const { inst, incus } = await fixture();
    const remote = { status: 'Stopped', config: { 'user.paledove.id': String(inst.id) }, devices: { eth0: { 'ipv4.address': inst.privateIp } } } as unknown as IncusInstance;
    vi.spyOn(incus, 'instanceExists').mockResolvedValue(true);
    vi.spyOn(incus, 'getInstance').mockImplementation(async () => structuredClone(remote));
    vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([]);
    const modify = vi.spyOn(incus, 'modifyInstance').mockRejectedValueOnce(new Error('Host update interrupted'));
    await expect(recovery.withPrivateIpRecovery(inst, incus, async () => {
      await recovery.syncProvisioningNetwork(inst, incus);
      throw collision(inst.privateIp!);
    })).rejects.toThrow('Host update interrupted');
    expect(inst.privateIp).toBe('10.88.255.253');
    const persisted = await db.instance.findUniqueOrThrow({ where: { id: inst.id }, include: { node: true, image: true, ipAddress: true, portMappings: true } });
    modify.mockImplementation(async (_name, mutate) => { mutate(remote); });
    await recovery.withPrivateIpRecovery(persisted, incus, () => recovery.syncProvisioningNetwork(persisted, incus));
    expect(remote.devices.eth0['ipv4.address']).toBe(persisted.privateIp);
    expect(persisted.privateIp).toBe('10.88.255.253');
  });

  it('limits recovery attempts and preserves unrelated startup errors', async () => {
    const { inst, incus } = await fixture();
    vi.spyOn(incus, 'instanceExists').mockResolvedValue(false);
    vi.spyOn(incus, 'getNetworkLeases').mockResolvedValue([]);
    const start = vi.fn(async () => { throw collision(inst.privateIp!); });
    await expect(recovery.withPrivateIpRecovery(inst, incus, start)).rejects.toThrow('already defined on another NIC');
    expect(start).toHaveBeenCalledTimes(4);
    const ip = inst.privateIp;
    await expect(recovery.withPrivateIpRecovery(inst, incus, async () => { throw new Error('Storage pool unavailable'); })).rejects.toThrow('Storage pool unavailable');
    expect((await db.instance.findUniqueOrThrow({ where: { id: inst.id } })).privateIp).toBe(ip);
  });

  it.each(['provisioned', 'provisioned-in-db', 'deleted', 'running', 'foreign'] as const)('does not renumber a %s instance', async (kind) => {
    const { inst, incus } = await fixture();
    if (kind === 'provisioned') inst.provisionedAt = new Date();
    if (kind === 'provisioned-in-db') await db.instance.update({ where: { id: inst.id }, data: { provisionedAt: new Date() } });
    if (kind === 'deleted') await db.instance.update({ where: { id: inst.id }, data: { status: 'DELETED' } });
    vi.spyOn(incus, 'instanceExists').mockResolvedValue(true);
    vi.spyOn(incus, 'getInstance').mockResolvedValue({ status: kind === 'running' ? 'Running' : 'Stopped', config: { 'user.paledove.id': kind === 'foreign' ? '999999' : String(inst.id) } } as unknown as IncusInstance);
    const query = vi.spyOn(incus, 'getNetworkLeases');
    await expect(recovery.withPrivateIpRecovery(inst, incus, async () => { throw collision(inst.privateIp!); })).rejects.toThrow('already defined on another NIC');
    expect((await db.instance.findUniqueOrThrow({ where: { id: inst.id } })).privateIp).toBe('10.88.255.254');
    expect(query).not.toHaveBeenCalled();
  });
});
