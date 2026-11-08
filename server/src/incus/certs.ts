import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { t } from '../i18n/index.ts';
import { AppError } from '../lib/errors.ts';

/** 开发者部署到本地文件目录的面板客户端证书，供 Incus 与 Caddy 共用。 */
export interface ClientCertificate {
  cert: string;
  key: string;
  fingerprint: string;
}

const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
let cached: { certPem: string; keyPem: string; x509: X509Certificate; value: ClientCertificate } | null = null;

export function getClientCertificatePaths() {
  return {
    certificatePath: join(config.incusCertificateDirectory, 'client.crt'),
    privateKeyPath: join(config.incusCertificateDirectory, 'client.key'),
  };
}

const unavailable = (message: string) => new AppError(503, 'INCUS_CERTIFICATE_UNAVAILABLE', message);

async function readPem(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw unavailable(t(missing ? 'cert.fileMissing' : 'cert.fileUnreadable', { path }));
  }
}

function checkValidity(x509: X509Certificate) {
  if (new Date(x509.validFrom).getTime() > Date.now()) throw unavailable(t('cert.notYetValid'));
  if (new Date(x509.validTo).getTime() <= Date.now()) throw unavailable(t('cert.expired'));
}

/** 只读取文件，不生成、不写入、不从数据库恢复。每次比较文件内容以检测手动替换。 */
export async function getClientCertificate(): Promise<ClientCertificate> {
  const { certificatePath, privateKeyPath } = getClientCertificatePaths();
  const [certPem, keyPem] = await Promise.all([readPem(certificatePath), readPem(privateKeyPath)]);
  if (cached?.certPem === certPem && cached.keyPem === keyPem) {
    checkValidity(cached.x509);
    return cached.value;
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certPem);
  } catch {
    throw unavailable(t('cert.invalidCert'));
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw unavailable(t('cert.invalidKey'));
  }
  if (!x509.checkPrivateKey(key)) throw unavailable(t('cert.keyMismatch'));
  checkValidity(x509);
  if (x509.keyUsage?.length && !x509.keyUsage.includes(OID_CLIENT_AUTH)) throw unavailable(t('cert.notClientAuth'));

  const value: ClientCertificate = {
    cert: x509.toString(),
    key: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
  };
  cached = { certPem, keyPem, x509, value };
  return value;
}
