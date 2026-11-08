import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { consoleRedirect, LEGACY_CONSOLE_PATHS, loginLanding } from '../src/shared/access';

interface Route {
  path?: string;
  index?: boolean;
  page: string;
  children?: Route[];
}

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { matchRoutes } = require('react-router') as {
  matchRoutes(routes: Route[], location: string): Array<{ route: Route; params: Record<string, string> }> | null;
};

// Read the actual JSX route declarations so missing or incorrectly nested paths fail routing checks.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const routes: Route[] = [];
function readRoute(node: ts.JsxElement | ts.JsxSelfClosingElement): Route {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
  const path = attrs.find((a) => a.name.getText(source) === 'path')?.initializer;
  const element = attrs.find((a) => a.name.getText(source) === 'element')?.initializer;
  const children = ts.isJsxElement(node) ? node.children.filter((child): child is ts.JsxElement | ts.JsxSelfClosingElement =>
    (ts.isJsxElement(child) && child.openingElement.tagName.getText(source) === 'Route') ||
    (ts.isJsxSelfClosingElement(child) && child.tagName.getText(source) === 'Route'),
  ).map(readRoute) : [];
  return {
    path: path && ts.isStringLiteral(path) ? path.text : undefined,
    index: attrs.some((a) => a.name.getText(source) === 'index') || undefined,
    page: element?.getText(source) ?? '',
    ...(children.length ? { children } : {}),
  };
}
function visit(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Routes') {
    for (const child of node.children) {
      if (ts.isJsxElement(child) && child.openingElement.tagName.getText(source) === 'Route') routes.push(readRoute(child));
      else if (ts.isJsxSelfClosingElement(child) && child.tagName.getText(source) === 'Route') routes.push(readRoute(child));
    }
  } else ts.forEachChild(node, visit);
}
visit(source);

describe('console page routes', () => {
  it.each([
    ['dashboard', 'Dashboard'], ['instances', 'Instances'], ['instances/12', 'InstanceDetail'],
    ['vpc', 'Vpcs'], ['billing', 'Billing'], ['invoices', 'Invoices'], ['invoices/7', 'InvoiceDetail'],
    ['invite', 'Affiliate'], ['account', 'Account'], ['terminal', 'TerminalPage'], ['docs/api', 'ApiDocs'],
    ['transfer', 'TransferPage'], ['store', 'Store'], ['marketplace', 'MarketPage'], ['marketplace/mine', 'MyListingsPage'],
    ['documents', 'DocumentsPage'], ['documents/getting-started', 'DocumentDetail'], ['activity', 'Activity'],
    ['notifications', 'Notifications'], ['tickets', 'Tickets'], ['tickets/new', 'Tickets create'], ['tickets/9', 'Tickets'],
  ])('opens /console/%s in the authenticated user layout', (path, page) => {
    const matches = matchRoutes(routes, `/console/${path}?tab=details`)!;
    expect(matches[0].route.path).toBe('/console');
    expect(matches[0].route.page).toContain('<RequireAuth>');
    expect(matches.at(-1)!.route.page).toContain(`<${page}`);
  });

  it('opens the console root at its dashboard and preserves public and admin routes', () => {
    expect(matchRoutes(routes, '/console')!.at(-1)!.route.page).toContain('to="/console/dashboard"');
    expect(matchRoutes(routes, '/store')!.at(-1)!.route.page).toContain('<Store');
    expect(matchRoutes(routes, '/market')!.at(-1)!.route.page).toContain('<MarketPage');
    expect(matchRoutes(routes, '/admin/instances/12')![0].route.path).toBe('/admin');
    expect(matchRoutes(routes, '/console/invoices/7')!.at(-1)!.params.id).toBe('7');
  });

  it('normalizes all old console paths, including details, while keeping login query parameters and anchors', () => {
    for (const path of LEGACY_CONSOLE_PATHS) {
      expect(consoleRedirect(path)).toBe(`/console${path}`);
      expect(consoleRedirect(`${path}/12`)).toBe(`/console${path}/12`);
      expect(loginLanding('USER', `${path}?tab=details#section`)).toBe(`/console${path}?tab=details#section`);
    }
    for (const path of ['/api/instances', '/admin/account', '/store', '/market', '/console/instances', '/instances-other']) expect(consoleRedirect(path)).toBeNull();
    expect(loginLanding('USER')).toBe('/console/dashboard');
    expect(loginLanding('ADMIN', '/console/billing')).toBe('/admin');
  });
});
