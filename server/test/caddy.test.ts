import { describe, expect, it } from 'vitest';
import { normalizeDomain, parseUpstream, pemToDer, renderCaddyConfig } from '../src/services/caddy.ts';

const admin = { adminPort: 2021, publicIp: '203.0.113.10', panelCertDer: 'MIIBdummy' };

describe('caddy helpers', () => {
  it('normalizes and validates domains', () => {
    expect(normalizeDomain('  Blog.Example.COM. ')).toBe('blog.example.com');
    expect(normalizeDomain('a-b.c.example.io')).toBe('a-b.c.example.io');
    for (const bad of ['example', '-bad.com', 'bad-.com', 'exa mple.com', 'evil.com {\n}', 'a..com', '1.2.3.4']) {
      expect(() => normalizeDomain(bad), bad).toThrow();
    }
  });

  it('parses upstreams', () => {
    expect(parseUpstream('10.0.0.5:8080')).toEqual({ dial: '10.0.0.5:8080', host: '10.0.0.5', tls: false });
    expect(parseUpstream('10.0.0.5')).toEqual({ dial: '10.0.0.5:80', host: '10.0.0.5', tls: false });
    expect(parseUpstream('http://app.internal:3000')).toEqual({ dial: 'app.internal:3000', host: 'app.internal', tls: false });
    expect(parseUpstream('https://origin.example.com')).toEqual({ dial: 'origin.example.com:443', host: 'origin.example.com', tls: true });
    expect(parseUpstream('[fd00::5]:8443')).toEqual({ dial: '[fd00::5]:8443', host: 'fd00::5', tls: false });
    expect(parseUpstream('https://[fd00::5]')).toEqual({ dial: '[fd00::5]:443', host: 'fd00::5', tls: true });
    for (const bad of ['', 'http://a.com/path', 'http://u:p@a.com', '10.0.0.5:99999', 'a b:80', 'ftp://a.com', 'a.com:80:90']) {
      expect(() => parseUpstream(bad), bad).toThrow();
    }
  });

  it('renders https and http sites with a locked-down admin endpoint', () => {
    const cfg = renderCaddyConfig(
      admin,
      [
        { domain: 'a.example.com', https: true, upstream: parseUpstream('10.0.0.5:80') },
        { domain: 'b.example.com', https: false, upstream: parseUpstream('10.0.0.6:8080') },
        { domain: 'c.example.com', https: true, upstream: parseUpstream('https://origin.example.net') },
      ],
      'ops@example.com',
    ) as any;
    expect(cfg.admin.listen).toBe('localhost:2019');
    expect(cfg.admin.remote).toEqual({ listen: ':2021', access_control: [{ public_keys: ['MIIBdummy'] }] });
    expect(cfg.admin.identity.identifiers).toEqual(['203.0.113.10']);

    const https = cfg.apps.http.servers.paledove_https;
    expect(https.listen).toEqual([':443']);
    expect(https.routes[0]).toEqual({
      match: [{ host: ['a.example.com'] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.5:80' }] }],
      terminal: true,
    });
    // HTTPS 上游：启用 TLS 传输并改写 Host
    expect(https.routes[1].handle[0].transport).toEqual({ protocol: 'http', tls: {} });
    expect(https.routes[1].handle[0].headers.request.set.Host).toEqual(['{http.reverse_proxy.upstream.hostport}']);

    const http = cfg.apps.http.servers.paledove_http;
    expect(http.listen).toEqual([':80']);
    expect(http.routes[0].match).toEqual([{ host: ['b.example.com'] }]);
    expect(cfg.apps.tls.automation.policies[0].issuers[0]).toEqual({ module: 'acme', email: 'ops@example.com' });
  });

  it('renders only the admin block when there are no sites', () => {
    const cfg = renderCaddyConfig(admin, [], 'ops@example.com') as any;
    expect(cfg.apps).toEqual({});
    expect(cfg.admin.remote.listen).toBe(':2021');
  });

  it('uses the dedicated admin CA without changing the public site certificate issuer', () => {
    const caId = 'paledove-admin-0123456789abcdef';
    const cfg = renderCaddyConfig(
      { ...admin, caId },
      [{ domain: 'a.example.com', https: true, upstream: parseUpstream('10.0.0.5:80') }],
      'ops@example.com',
    ) as any;
    expect(cfg.admin.identity.issuers).toEqual([{ module: 'internal', ca: caId }]);
    expect(cfg.apps.tls.automation.policies[0].issuers).toEqual([{ module: 'acme', email: 'ops@example.com' }]);
  });

  it('converts PEM to base64 DER', () => {
    expect(pemToDer('-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----\n')).toBe('AAAABBBB');
  });
});
