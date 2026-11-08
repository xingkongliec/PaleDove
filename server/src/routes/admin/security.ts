// 管理后台 → 系统设置 → 第三方登录（GitHub / Google / 自定义 OAuth 2.0 / OIDC、绑定要求），以及重置用户的两步验证
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encrypt } from '../../lib/crypto.ts';
import { badRequest, conflict, notFound } from '../../lib/errors.ts';
import { adminGuard, ensureFound, idParam, logActivity, panelUrl, parse, requireAdmin } from '../../lib/http.ts';
import { prisma } from '../../lib/prisma.ts';
import { getSetting, setSetting, type OAuthCustomProvider } from '../../lib/settings.ts';
import { t } from '../../i18n/index.ts';
import { BUILTIN_PROVIDERS, callbackUrl, discoverOidc, listProviders, oauthIconUrl, PROVIDER_ID_RE, RESERVED_PROVIDER_IDS } from '../../services/oauth.ts';
import { decodeIcon, downloadIcon } from '../../services/site-icon.ts';

/** 返回给前端的第三方登录设置：不返回密钥，只给出是否已配置 */
async function oauthView(req: FastifyRequest) {
  const oauth = await getSetting('oauth');
  const base = panelUrl(req);
  return {
    ...Object.fromEntries(
      BUILTIN_PROVIDERS.map((p) => [p, { enabled: oauth[p].enabled, clientId: oauth[p].clientId, hasSecret: !!oauth[p].clientSecretEnc, callbackUrl: callbackUrl(base, p) }]),
    ),
    custom: oauth.custom.map(({ clientSecretEnc, ...c }) => ({ ...c, icon: oauthIconUrl(c), hasSecret: !!clientSecretEnc, callbackUrl: callbackUrl(base, c.id) })),
    require: oauth.require,
    providers: listProviders(oauth),
  };
}

export default async function adminSecurityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/settings/oauth', async (req) => oauthView(req));

  app.put('/api/admin/settings/oauth/:provider', async (req) => {
    const admin = requireAdmin(req);
    const { provider } = parse(z.object({ provider: z.enum(BUILTIN_PROVIDERS) }), req.params);
    const body = parse(z.object({ enabled: z.boolean(), clientId: z.string().trim().max(256), clientSecret: z.string().trim().max(512).optional() }), req.body);
    const all = await getSetting('oauth');
    const cur = all[provider];
    const next = { enabled: body.enabled, clientId: body.clientId, clientSecretEnc: body.clientSecret ? encrypt(body.clientSecret) : cur.clientSecretEnc };
    if (next.enabled && (!next.clientId || !next.clientSecretEnc)) throw badRequest(t('oauthAdmin.builtinIncomplete'));
    await setSetting('oauth', { [provider]: next });
    await logActivity(req, admin.id, 'admin.oauth_update', provider);
    return oauthView(req);
  });

  // 自定义 OAuth 2.0 / OIDC 提供商
  const endpointSchema = z
    .string()
    .trim()
    .max(512)
    .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), { message: 'endpoint' });
  const fieldSchema = z
    .string()
    .trim()
    .max(64)
    .regex(/^$|^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, { message: 'field' });
  const customSchema = () =>
    z.object({
      name: z.string().trim().min(1, t('oauthAdmin.nameRequired')).max(32),
      enabled: z.boolean(),
      clientId: z.string().trim().max(256),
      clientSecret: z.string().trim().max(1024).optional(),
      authorizeUrl: endpointSchema,
      tokenUrl: endpointSchema,
      userinfoUrl: endpointSchema,
      scope: z.string().trim().max(256).default(''),
      tokenAuth: z.enum(['post', 'basic']).default('post'),
      idField: fieldSchema.default('sub'),
      emailField: fieldSchema.default('email'),
      nameField: fieldSchema.default('name'),
      trustEmail: z.boolean().default(false),
      emailVerifiedField: fieldSchema.default(''),
    });
  type CustomInput = z.infer<ReturnType<typeof customSchema>>;
  /** 字段校验的错误信息依赖当前语言，解析失败时换成对应的提示 */
  const parseCustom = (raw: unknown): CustomInput => {
    const r = customSchema().safeParse(raw);
    if (r.success) return r.data;
    const issue = r.error.issues[0];
    if (issue?.message === 'endpoint') throw badRequest(t('oauthAdmin.endpointInvalid'));
    if (issue?.message === 'field') throw badRequest(t('oauthAdmin.fieldInvalid'));
    return parse(customSchema(), raw);
  };
  const buildCustom = (id: string, body: CustomInput, cur?: OAuthCustomProvider): OAuthCustomProvider => {
    const { clientSecret, ...rest } = body;
    const next: OAuthCustomProvider = { ...rest, id, idField: rest.idField || 'sub', clientSecretEnc: clientSecret ? encrypt(clientSecret) : (cur?.clientSecretEnc ?? ''), iconVersion: cur?.iconVersion ?? 0 };
    if (next.enabled) {
      if (!next.clientId || !next.clientSecretEnc) throw badRequest(t('oauthAdmin.clientRequired'));
      if (!next.authorizeUrl || !next.tokenUrl || !next.userinfoUrl) throw badRequest(t('oauthAdmin.endpointsRequired'));
    }
    return next;
  };

  // 图标：填写图片链接（服务端下载）或上传图片（base64），不传 = 不修改，null = 恢复默认（显示名称首字）
  const OAUTH_ICON_MAX = 256 * 1024;
  const iconSchema = z.object({
    icon: z
      .union([z.object({ url: z.string().trim().min(1).max(2048) }), z.object({ data: z.string().min(1).max(360_000) })])
      .nullable()
      .optional(),
  });
  /** 先下载 / 校验图标再保存设置，图标有问题时整个请求失败 */
  const loadIcon = async (raw: unknown) => {
    const r = iconSchema.safeParse(raw);
    if (!r.success) throw badRequest(t('oauthAdmin.iconInvalid'));
    const { icon } = r.data;
    if (!icon) return icon;
    try {
      return 'url' in icon ? await downloadIcon(icon.url, OAUTH_ICON_MAX) : decodeIcon(icon.data, OAUTH_ICON_MAX);
    } catch (e) {
      throw badRequest(t('oauthAdmin.iconError', { message: (e as Error).message }));
    }
  };
  /** 保存 / 删除图标，返回新的图标版本（undefined = 没有修改） */
  const saveIcon = async (id: string, icon: Awaited<ReturnType<typeof loadIcon>>) => {
    if (icon === undefined) return undefined;
    const icons = { ...(await getSetting('oauthIcons')).icons };
    if (icon) icons[id] = icon;
    else delete icons[id];
    await setSetting('oauthIcons', { icons });
    return icon ? Date.now() : 0;
  };

  app.post('/api/admin/settings/oauth/custom', async (req) => {
    const admin = requireAdmin(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const idRes = z.object({ id: z.string().trim().toLowerCase().regex(PROVIDER_ID_RE) }).safeParse(raw);
    if (!idRes.success) throw badRequest(t('oauthAdmin.idInvalid'));
    const { id } = idRes.data;
    const all = await getSetting('oauth');
    if (RESERVED_PROVIDER_IDS.has(id) || all.custom.some((c) => c.id === id)) throw conflict(t('oauthAdmin.idTaken', { id }));
    if (all.custom.length >= 20) throw badRequest(t('oauthAdmin.tooMany'));
    const next = buildCustom(id, parseCustom(raw));
    next.iconVersion = (await saveIcon(id, await loadIcon(raw))) ?? 0;
    await setSetting('oauth', { custom: [...all.custom, next] });
    await logActivity(req, admin.id, 'admin.oauth_create', `${next.name} (${id})`);
    return oauthView(req);
  });

  app.put('/api/admin/settings/oauth/custom/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const all = await getSetting('oauth');
    const cur = all.custom.find((c) => c.id === id);
    if (!cur) throw notFound(t('oauthAdmin.notFound'));
    const next = buildCustom(id, parseCustom(req.body), cur);
    next.iconVersion = (await saveIcon(id, await loadIcon(req.body))) ?? next.iconVersion;
    await setSetting('oauth', { custom: all.custom.map((c) => (c.id === id ? next : c)) });
    await logActivity(req, admin.id, 'admin.oauth_update', `${next.name} (${id})`);
    return oauthView(req);
  });

  app.delete('/api/admin/settings/oauth/custom/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const all = await getSetting('oauth');
    const cur = all.custom.find((c) => c.id === id);
    if (!cur) throw notFound(t('oauthAdmin.notFound'));
    // 删除后已绑定的用户无法再用它登录（没有密码的账号会登录不上），有绑定时只允许停用
    const bound = await prisma.oAuthAccount.count({ where: { provider: id } });
    if (bound) throw conflict(t('oauthAdmin.inUse', { n: bound, name: cur.name }));
    await setSetting('oauth', { custom: all.custom.filter((c) => c.id !== id), require: { ...all.require, providers: all.require.providers.filter((p) => p !== id) } });
    await saveIcon(id, null);
    await logActivity(req, admin.id, 'admin.oauth_delete', `${cur.name} (${id})`);
    return oauthView(req);
  });

  app.post('/api/admin/settings/oauth/discover', async (req) => {
    const { issuer } = parse(z.object({ issuer: z.string().trim().min(1).max(512) }), req.body);
    return discoverOidc(issuer);
  });

  app.put('/api/admin/settings/oauth-require', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({ providers: z.array(z.string()).max(30), mode: z.enum(['any', 'all']) }), req.body);
    const all = await getSetting('oauth');
    const known = listProviders(all);
    const unknown = body.providers.filter((p) => !known.some((k) => k.id === p));
    if (unknown.length) throw badRequest(t('oauthAdmin.requireUnknown', { list: unknown.join(', ') }));
    const inactive = known.filter((k) => body.providers.includes(k.id) && !k.active);
    if (inactive.length) throw badRequest(t('oauthAdmin.requireInactive', { list: inactive.map((k) => k.name).join(', ') }));
    await setSetting('oauth', { require: { providers: [...new Set(body.providers)], mode: body.mode } });
    await logActivity(req, admin.id, 'admin.oauth_require', body.providers.length ? known.filter((k) => body.providers.includes(k.id)).map((k) => k.name).join(body.mode === 'all' ? ' + ' : ' / ') : '-');
    return oauthView(req);
  });

  // ───────── 用户安全 ─────────

  // 用户丢失认证器且恢复码用完时，由管理员关闭其两步验证
  app.post('/api/admin/users/:id/reset-2fa', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    await prisma.user.update({ where: { id }, data: { totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null, recoveryCodes: '[]' } });
    await logActivity(req, admin.id, 'admin.user_reset_2fa', user.username);
    return { ok: true };
  });
}
