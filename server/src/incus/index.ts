import type { Node } from '../lib/prisma.ts';
import { getClientCertificate, type ClientCertificate } from './certs.ts';
import { HttpIncusClient } from './client.ts';
import { MockIncusClient } from './mock.ts';
import type { IncusApi } from './types.ts';

export * from './types.ts';

type NodeConn = Pick<Node, 'id' | 'endpoint' | 'project' | 'serverFingerprint'>;

const clients = new Map<number, { sig: string; client: IncusApi }>();

/** 获取（并缓存）节点对应的 Incus 客户端 */
export async function getIncus(node: NodeConn): Promise<IncusApi> {
  const certificate = node.endpoint.startsWith('mock://') ? undefined : await getClientCertificate();
  const sig = `${node.endpoint}|${node.project}|${node.serverFingerprint ?? ''}|${certificate?.fingerprint ?? ''}`;
  const hit = clients.get(node.id);
  if (hit && hit.sig === sig) return hit.client;
  if (hit && hit.client instanceof HttpIncusClient) void hit.client.close().catch(() => undefined);
  const client = await createIncusClient(node, certificate);
  if (!node.endpoint.startsWith('mock://')) {
    const exec = client.exec.bind(client);
    client.exec = async (name, command, opts) => {
      try { return await exec(name, command, opts); }
      catch (error) {
        const { guestAgentUnavailable, execViaHost } = await import('../services/agent/guest-exec.ts');
        if (!guestAgentUnavailable(error)) throw error;
        return execViaHost(node.id, name, command, opts);
      }
    };
  }
  clients.set(node.id, { sig, client });
  return client;
}

/** 创建一次性客户端（不缓存），用于节点连接测试 */
export async function createIncusClient(node: Omit<NodeConn, 'id'>, certificate?: ClientCertificate): Promise<IncusApi> {
  if (node.endpoint.startsWith('mock://')) return new MockIncusClient(node.endpoint);
  const { cert, key } = certificate ?? await getClientCertificate();
  return new HttpIncusClient({
    endpoint: node.endpoint,
    project: node.project,
    cert,
    key,
    fingerprint: node.serverFingerprint,
  });
}

/** 关闭并清空全部缓存的客户端（例如更换面板证书后） */
export function invalidateAllIncus(): void {
  for (const id of [...clients.keys()]) invalidateIncus(id);
}

export function invalidateIncus(nodeId: number): void {
  const hit = clients.get(nodeId);
  if (hit && hit.client instanceof HttpIncusClient) void hit.client.close().catch(() => undefined);
  clients.delete(nodeId);
}
