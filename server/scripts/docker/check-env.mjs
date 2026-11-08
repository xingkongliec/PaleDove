import { pathToFileURL } from 'node:url';

const placeholders = new Set(['replace-with-a-random-secret', 'change-me-to-a-long-random-string', 'replace-with-a-strong-admin-password', 'admin123456']);

/** 容器只支持外部 PostgreSQL / Redis；提前报配置项名称，不输出连接串或密码。 */
export function validateEnvironment(env, command = 'start') {
  const errors = [];
  const checkUrl = (name, protocols) => {
    try {
      const url = new URL(env[name]);
      if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
    } catch {
      errors.push(`${name} must use ${protocols.join(' or ')} with an external service hostname.`);
    }
  };
  checkUrl('DATABASE_URL', ['postgresql:', 'postgres:']);
  if (command !== 'migrate') {
    checkUrl('REDIS_URL', ['redis:', 'rediss:']);
    if (!env.APP_SECRET || env.APP_SECRET.length < 16 || placeholders.has(env.APP_SECRET)) errors.push('APP_SECRET must be a random secret of at least 16 characters; keep it unchanged after deployment.');
  }
  if (command === 'start') {
    for (const name of ['DB_MIGRATE', 'RUN_API', 'RUN_WORKER']) {
      if (env[name] !== undefined && !['true', 'false'].includes(env[name])) errors.push(`${name} must be true or false.`);
    }
    if (env.RUN_API === 'false' && env.RUN_WORKER === 'false') errors.push('Enable RUN_API or RUN_WORKER.');
  }
  if (command === 'init' || command === 'seed') {
    if (env.SEED_DEMO && env.SEED_DEMO !== 'false') errors.push('SEED_DEMO must be false for container deployment.');
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateEnvironment(process.env, process.argv[2]);
  if (errors.length) {
    console.error('Invalid container configuration:\n' + errors.map(error => `  ${error}`).join('\n'));
    process.exitCode = 1;
  }
}
