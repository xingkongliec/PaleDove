import { describe, expect, it } from 'vitest';
import {
  allocateFromCidr,
  allocateIpv6,
  bigIntToIpv6,
  cidrContains,
  expandIpInput,
  formatIpv6Cidr,
  intToIp,
  ipToInt,
  ipv6ToBigInt,
  isIPv4,
  parseCidr,
  parseIpv6Cidr,
} from '../src/lib/ip.ts';

describe('ip utils', () => {
  it('validates IPv4 addresses', () => {
    expect(isIPv4('203.0.113.5')).toBe(true);
    expect(isIPv4('0.0.0.0')).toBe(true);
    expect(isIPv4('256.1.1.1')).toBe(false);
    expect(isIPv4('01.2.3.4')).toBe(false);
    expect(isIPv4('1.2.3')).toBe(false);
  });

  it('round-trips int conversion', () => {
    expect(intToIp(ipToInt('10.20.30.40'))).toBe('10.20.30.40');
    expect(ipToInt('255.255.255.255')).toBe(0xffffffff);
  });

  it('parses CIDR network and broadcast', () => {
    const c = parseCidr('10.0.0.1/24');
    expect(intToIp(c.network)).toBe('10.0.0.0');
    expect(intToIp(c.broadcast)).toBe('10.0.0.255');
    expect(cidrContains('10.0.0.1/24', '10.0.0.200')).toBe(true);
    expect(cidrContains('10.0.0.1/24', '10.0.1.1')).toBe(false);
  });

  it('expands single, CIDR and range input', () => {
    expect(expandIpInput('203.0.113.0/29')).toEqual([
      '203.0.113.1',
      '203.0.113.2',
      '203.0.113.3',
      '203.0.113.4',
      '203.0.113.5',
      '203.0.113.6',
    ]);
    expect(expandIpInput('198.51.100.10-12')).toEqual(['198.51.100.10', '198.51.100.11', '198.51.100.12']);
    expect(expandIpInput('1.1.1.1\n1.1.1.1, 2.2.2.2')).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(expandIpInput('192.0.2.7/32')).toEqual(['192.0.2.7']);
    expect(() => expandIpInput('1.1.1.9-1.1.1.2')).toThrow();
    expect(() => expandIpInput('not-an-ip')).toThrow();
    expect(() => expandIpInput('10.0.0.0/8', 100)).toThrow();
  });

  it('allocates from the top of the subnet, skipping used and gateway', () => {
    expect(allocateFromCidr('10.0.0.1/24', new Set())).toBe('10.0.0.254');
    expect(allocateFromCidr('10.0.0.1/24', new Set(['10.0.0.254']))).toBe('10.0.0.253');
    // 网关位于高位时跳过
    expect(allocateFromCidr('10.0.0.254/24', new Set())).toBe('10.0.0.253');
  });

  it('returns null when the subnet is exhausted', () => {
    const used = new Set<string>();
    for (let i = 11; i <= 14; i++) used.add(`10.0.0.${i}`);
    // /28 网段：.1 为网关，保留 .1-.10，可分配 .11-.14
    expect(allocateFromCidr('10.0.0.1/28', used)).toBeNull();
  });

  it('parses and formats IPv6', () => {
    expect(bigIntToIpv6(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe('2001:db8::1');
    expect(bigIntToIpv6(ipv6ToBigInt('::'))).toBe('::');
    expect(bigIntToIpv6(ipv6ToBigInt('fe80::1:2'))).toBe('fe80::1:2');
    expect(() => ipv6ToBigInt('::ffff:1.2.3.4')).toThrow();
    expect(() => ipv6ToBigInt('1.2.3.4')).toThrow();
  });

  it('aligns IPv6 subnets to the prefix', () => {
    expect(formatIpv6Cidr(parseIpv6Cidr('2001:db8:1:2::5/64'))).toBe('2001:db8:1:2::/64');
    expect(formatIpv6Cidr(parseIpv6Cidr('2001:db8:abcd::/48'))).toBe('2001:db8:abcd::/48');
    expect(() => parseIpv6Cidr('2001:db8::/129')).toThrow();
    expect(() => parseIpv6Cidr('2001:db8::')).toThrow();
  });

  it('allocates IPv6 addresses inside the subnet', () => {
    const net = parseIpv6Cidr('2001:db8:1:2::/64');
    const used = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ip = allocateIpv6('2001:db8:1:2::/64', used)!;
      expect(parseIpv6Cidr(`${ip}/64`).network).toBe(net.network);
      expect(used.has(ip)).toBe(false);
      used.add(ip);
    }
    // /126 只有 ::2、::3 两个可分配地址
    const small = new Set([allocateIpv6('2001:db8::/126', new Set())!]);
    small.add(allocateIpv6('2001:db8::/126', small)!);
    expect([...small].sort()).toEqual(['2001:db8::2', '2001:db8::3']);
    expect(allocateIpv6('2001:db8::/126', small)).toBeNull();
  });
});
