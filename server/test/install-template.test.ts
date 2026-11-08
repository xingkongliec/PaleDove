import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentSetupSection, renderAgentInstallScript, renderCaddyInstallScript, renderNodeInstallScript } from '../src/services/agent/install-script.ts';

const files = vi.hoisted(() => ({ directory: '' }));

// 将模板读取转到临时副本，验证真实文件更新而不改动项目模板。
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (path: Parameters<typeof fs.readFileSync>[0], options: Parameters<typeof fs.readFileSync>[1]) => {
      const target = files.directory && path instanceof URL && path.pathname.includes('/templates/')
        ? join(files.directory, basename(fileURLToPath(path)))
        : path;
      return fs.readFileSync(target, options);
    },
  };
});

const options = {
  panelUrl: 'https://panel.example.com', token: 'isolated-install-token', nodeName: 'test-node',
  apiPort: 8443, poolName: 'default', storageDriver: 'dir', storageSource: null, storageSize: '20GiB',
  natNetwork: 'incusbr0', natCidr: '10.88.0.1/16', portRangeStart: 20000, portRangeEnd: 29999,
  publicIp: '203.0.113.1', ipv6: false, ipv6Parent: '', panelCert: 'test-certificate',
  agentInstallToken: 'pdi_isolated-token',
};

describe('install template refresh', () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'paledove-install-templates-'));
    files.directory = join(directory, 'templates');
    cpSync(new URL('../templates/', import.meta.url), files.directory, { recursive: true });
  });

  afterAll(() => {
    files.directory = '';
    if (!directory.startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('paledove-install-templates-')) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  });

  it('resolves templates beside the production bundle regardless of the working directory', async () => {
    const output = join(directory, 'dist', 'install-script.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../src/services/agent/install-script.ts', import.meta.url))],
      outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    });
    // 子进程不使用 Vitest 的 fs mock，验证真正打包后的 import.meta.url 路径。
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(process.argv[1]);
      const o = JSON.parse(process.argv[2]);
      const scripts = [m.renderNodeInstallScript(o), m.renderAgentInstallScript(o), m.renderCaddyInstallScript({ ...o, adminPort: 2021, initialConfig: {} })];
      console.log(JSON.stringify(scripts.map(s => s.startsWith('#!/usr/bin/env bash') && !s.includes('@@PALEDOVE_'))));
    `, pathToFileURL(output).href, JSON.stringify(options)], { cwd: tmpdir(), encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual([true, true, true]);
  });

  for (const [name, render] of [
    ['install.sh', () => renderNodeInstallScript(options)],
    ['caddy.sh', () => renderCaddyInstallScript({ ...options, adminPort: 2021, initialConfig: { apps: {} } })],
    ['agent-install.sh', () => renderAgentInstallScript(options)],
  ] as const) {
    it(`reads the updated ${name} on the next request without reloading the module`, () => {
      const path = join(files.directory, name);
      const before = render();
      const marker = `# updated ${name}`;
      writeFileSync(path, readFileSync(path, 'utf8') + `\n${marker}\n`);
      expect(render()).toBe(before + `\n${marker}\n`);
    });
  }

  it('refreshes the shared Agent section in both Incus and standalone Agent scripts', () => {
    const path = join(files.directory, 'agent-setup.sh');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n# updated shared Agent section\n');
    expect(renderNodeInstallScript(options)).toContain('# updated shared Agent section');
    expect(renderAgentInstallScript(options)).toContain('# updated shared Agent section');
    expect(agentSetupSection(options.panelUrl)).toContain('# updated shared Agent section');
  });

  it('refreshes the interactive Incus menu on the next download', () => {
    const path = join(files.directory, 'install-ui.sh');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\n# updated interactive menu\n');
    try {
      expect(renderNodeInstallScript(options)).toContain('# updated interactive menu');
    } finally {
      writeFileSync(path, original);
    }
  });

  it('refreshes node removal in both the installer and its embedded maintenance command', () => {
    const path = join(files.directory, 'node-uninstall.sh');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\n# updated node removal\n');
    try {
      expect(renderNodeInstallScript(options).match(/# updated node removal/g)).toHaveLength(2);
    } finally {
      writeFileSync(path, original);
    }
  });

  it('keeps inserted shell values literal and never expands placeholders inside them', () => {
    const token = "pdi_$&_$'_$(touch unexpected)_@@PALEDOVE_PANEL_URL@@";
    const script = renderAgentInstallScript({ panelUrl: options.panelUrl, installToken: token });
    expect(script).toContain("@@PALEDOVE_PANEL_URL@@'");
    expect(script).toContain('$(touch unexpected)');
    expect(script).toContain("$&_$'\\''");
  });

  it('fails when a template is missing instead of returning an old cached script', () => {
    const path = join(files.directory, 'agent-install.sh');
    const original = readFileSync(path, 'utf8');
    unlinkSync(path);
    try {
      expect(() => renderAgentInstallScript(options)).toThrow(/ENOENT/);
    } finally {
      writeFileSync(path, original);
    }
  });

  it('rejects unknown template variables before returning a partial script', () => {
    const path = join(files.directory, 'caddy.sh');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\n@@PALEDOVE_MISSING_VALUE@@\n');
    try {
      expect(() => renderCaddyInstallScript({ ...options, adminPort: 2021, initialConfig: {} })).toThrow('Missing install template value: MISSING_VALUE');
    } finally {
      writeFileSync(path, original);
    }
  });
});
