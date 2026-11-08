// 系统设置 → 第三方登录：GitHub / Google、自定义 OAuth 2.0 / OIDC 登录方式，以及“购买前必须绑定”的要求
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, ImagePlus, Link2, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { oauthIcon } from '@/components/oauth-icon';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, PasswordInput } from '@/components/ui/input';
import { DropdownMenu } from '@/components/ui/menu';
import { Alert, Card, CardBody, CardHeader, Checkbox, FormRow, Switch, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Segmented } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/format';
import { toast } from '@/lib/toast';

export interface CustomProvider {
  id: string;
  name: string;
  /** 自定义图标地址，null = 显示名称首字 */
  icon: string | null;
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  callbackUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  tokenAuth: 'post' | 'basic';
  idField: string;
  emailField: string;
  nameField: string;
  trustEmail: boolean;
  emailVerifiedField: string;
}

interface BuiltinValue {
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  callbackUrl: string;
}

export interface OAuthAdminValue {
  github: BuiltinValue;
  google: BuiltinValue;
  custom: CustomProvider[];
  require: { providers: string[]; mode: 'any' | 'all' };
  providers: Array<{ id: string; name: string; active: boolean }>;
}

const KEY = ['admin-oauth'];

/** 第三方登录设置：保存后各卡片用返回的最新设置刷新 */
export function OAuthSettings() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<OAuthAdminValue>('/admin/settings/oauth') });
  const onSaved = (d: OAuthAdminValue) => {
    qc.setQueryData(KEY, d);
    void qc.invalidateQueries({ queryKey: ['public-config'] });
  };
  if (!q.data) return <div className="skeleton fade-in-delay h-32 rounded-lg" />;
  return (
    <div className="space-y-4">
      <Alert tone="neutral">{t('oauthAdmin.intro')}</Alert>
      <OAuthRequirementCard value={q.data} onSaved={onSaved} />
      <OAuthProviderForm provider="github" value={q.data.github} onSaved={onSaved} />
      <OAuthProviderForm provider="google" value={q.data.google} onSaved={onSaved} />
      <OAuthCustomProviders value={q.data} onSaved={onSaved} />
    </div>
  );
}

const OAUTH_GUIDE = { github: { name: 'GitHub', where: 'oauthAdmin.githubWhere' }, google: { name: 'Google', where: 'oauthAdmin.googleWhere' } } as const;


function OAuthProviderForm({ provider, value, onSaved }: { provider: 'github' | 'google'; value: BuiltinValue; onSaved: (d: OAuthAdminValue) => void }) {
  const t = useT();
  const g = OAUTH_GUIDE[provider];
  const [form, setForm] = useState({ enabled: value.enabled, clientId: value.clientId, clientSecret: '' });
  useEffect(() => setForm({ enabled: value.enabled, clientId: value.clientId, clientSecret: '' }), [value]);
  const save = useMutation({
    mutationFn: () => api.put<OAuthAdminValue>(`/admin/settings/oauth/${provider}`, { enabled: form.enabled, clientId: form.clientId, clientSecret: form.clientSecret || undefined }),
    onSuccess: (d) => {
      onSaved(d);
      toast.success(t('oauthAdmin.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2">{oauthIcon(provider, g.name)}{g.name}</span>} />
      <CardBody>
        <FormRow label={t('oauthAdmin.enabledRow')} hint={t('oauthAdmin.enableBuiltinHint', { name: g.name })}>
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} label={t('oauthAdmin.enableBuiltin', { name: g.name })} />
        </FormRow>
        <FormRow label={t('oauthAdmin.callback')} hint={t(g.where)}>
          <div className="flex max-w-xl items-center gap-2">
            <Input readOnly className="font-mono text-xs" value={value.callbackUrl} onFocus={(e) => e.target.select()} />
            <Button onClick={async () => (await copyText(value.callbackUrl)) && toast.success(t('common.copied'))}>{t('common.copy')}</Button>
          </div>
        </FormRow>
        <FormRow label="Client ID">
          <Input className="max-w-xl font-mono text-xs" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
        </FormRow>
        <FormRow label="Client Secret" hint={value.hasSecret ? t('oauthAdmin.secretKeep') : t('oauthAdmin.secretEncrypted')}>
          <div className="max-w-xl">
            <PasswordInput
              className="font-mono text-xs"
              autoComplete="new-password"
              value={form.clientSecret}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              placeholder={value.hasSecret ? '••••••••' : ''}
            />
          </div>
        </FormRow>
        <div className="mt-4 flex justify-end border-t border-line pt-4">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

const blank = {
  id: '',
  name: '',
  enabled: true,
  clientId: '',
  clientSecret: '',
  authorizeUrl: '',
  tokenUrl: '',
  userinfoUrl: '',
  scope: 'openid email profile',
  tokenAuth: 'post' as 'post' | 'basic',
  idField: 'sub',
  emailField: 'email',
  nameField: 'name',
  trustEmail: false,
  emailVerifiedField: 'email_verified',
};
type Form = typeof blank;

/** 图标的修改：keep = 不变，url = 填写链接（保存时由服务端下载），file = 上传的图片，reset = 恢复默认 */
type IconEdit = { kind: 'keep' } | { kind: 'url'; url: string } | { kind: 'file'; data: string } | { kind: 'reset' };
const ICON_MAX = 256 * 1024;
const iconBody = (e: IconEdit) => (e.kind === 'url' ? { url: e.url.trim() } : e.kind === 'file' ? { data: e.data } : e.kind === 'reset' ? null : undefined);

/** 图标：预览 + 图片链接 / 上传图片 / 恢复默认 */
function IconPicker({ name, current, value, onChange }: { name: string; current: string | null; value: IconEdit; onChange: (v: IconEdit) => void }) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const pickFile = (file?: File) => {
    if (!file) return;
    if (file.size > ICON_MAX) return toast.error(t('oauthAdmin.iconTooLarge'));
    const reader = new FileReader();
    reader.onload = () => onChange({ kind: 'file', data: String(reader.result) });
    reader.readAsDataURL(file);
  };
  // 外部链接不直接预览，保存后由服务端下载才显示
  const preview = value.kind === 'file' ? value.data : value.kind === 'keep' ? current : null;
  const custom = value.kind === 'url' || value.kind === 'file' || (value.kind === 'keep' && !!current);
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-line">
        {value.kind === 'url' ? <Link2 className="size-4 text-fg-4" /> : <span className="flex scale-[1.33]">{oauthIcon('', name || '?', preview)}</span>}
      </span>
      <Input
        className="min-w-0 flex-1 font-mono text-[13px]"
        value={value.kind === 'url' ? value.url : ''}
        onChange={(e) => onChange(e.target.value ? { kind: 'url', url: e.target.value } : { kind: 'keep' })}
        placeholder={value.kind === 'file' ? t('oauthAdmin.iconPicked') : 'https://example.com/logo.png'}
      />
      <Button icon={<ImagePlus className="size-4" />} onClick={() => fileRef.current?.click()}>
        {t('oauthAdmin.upload')}
      </Button>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon,.ico"
        onChange={(e) => {
          pickFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {/* 已有图标可以恢复默认；新选的（含恢复默认）可以撤销回原来的 */}
      {(custom || value.kind === 'reset') && (
        <Button variant="ghost" onClick={() => onChange(value.kind === 'keep' ? { kind: 'reset' } : { kind: 'keep' })}>
          {value.kind === 'keep' ? t('oauthAdmin.iconReset') : t('oauthAdmin.iconUndo')}
        </Button>
      )}
    </div>
  );
}

/** 回调地址的前缀取自内置提供商的回调地址（由后端按 PANEL_URL 生成） */
const callbackFor = (value: OAuthAdminValue, id: string, placeholder: string) => value.github.callbackUrl.replace(/github\/callback$/, `${id || placeholder}/callback`);

export function OAuthCustomProviders({ value, onSaved }: { value: OAuthAdminValue; onSaved: (d: OAuthAdminValue) => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<{ form: Form; existing: CustomProvider | null } | null>(null);
  const remove = async (p: CustomProvider) => {
    if (!(await confirm({ title: t('oauthAdmin.deleteTitle', { name: p.name }), description: t('oauthAdmin.deleteDesc'), danger: true, confirmText: t('common.delete') }))) return;
    try {
      onSaved(await api.delete<OAuthAdminValue>(`/admin/settings/oauth/custom/${encodeURIComponent(p.id)}`));
      toast.success(t('oauthAdmin.deleted'));
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <Card>
      <CardHeader
        title={t('oauthAdmin.customTitle')}
        actions={
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ form: { ...blank }, existing: null })}>
            {t('oauthAdmin.add')}
          </Button>
        }
      />
      <CardBody>
        <p className="-mt-1 mb-4 text-[13px] text-fg-3">{t('oauthAdmin.customDesc')}</p>
        {!value.custom.length ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-fg-3">{t('oauthAdmin.customEmpty')}</div>
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line">
            {value.custom.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                {oauthIcon(p.id, p.name, p.icon)}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                    <span translate="no">{p.name}</span>
                    <span className="font-mono text-xs font-normal text-fg-3">{p.id}</span>
                    {p.enabled ? <Tag tone="success">{t('oauthAdmin.enabled')}</Tag> : <Tag>{t('oauthAdmin.disabled')}</Tag>}
                    {value.require.providers.includes(p.id) && <Tag tone="warning">{t('oauthAdmin.mustBind')}</Tag>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-fg-3">{p.authorizeUrl || t('oauthAdmin.noAuthorizeUrl')}</div>
                </div>
                <Button size="sm" onClick={() => setEdit({ form: { ...blank, ...p, clientSecret: '' }, existing: p })}>
                  {t('common.edit')}
                </Button>
                <DropdownMenu
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={t('common.actions')}>
                      <Ellipsis />
                    </Button>
                  }
                  items={[{ label: t('common.delete'), danger: true, onClick: () => void remove(p) }]}
                />
              </div>
            ))}
          </div>
        )}
      </CardBody>
      <CustomProviderModal value={value} state={edit} onClose={() => setEdit(null)} onSaved={onSaved} />
    </Card>
  );
}

function CustomProviderModal({
  value,
  state,
  onClose,
  onSaved,
}: {
  value: OAuthAdminValue;
  state: { form: Form; existing: CustomProvider | null } | null;
  onClose: () => void;
  onSaved: (d: OAuthAdminValue) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<Form>(blank);
  const [issuer, setIssuer] = useState('');
  const [icon, setIcon] = useState<IconEdit>({ kind: 'keep' });
  useEffect(() => {
    if (state) {
      setForm(state.form);
      setIssuer('');
      setIcon({ kind: 'keep' });
    }
  }, [state]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const existing = state?.existing ?? null;
  const callback = callbackFor(value, form.id.trim().toLowerCase(), t('oauthAdmin.idPlaceholderInUrl'));

  const discover = useMutation({
    mutationFn: () => api.post<Pick<Form, 'authorizeUrl' | 'tokenUrl' | 'userinfoUrl' | 'tokenAuth' | 'scope'>>('/admin/settings/oauth/discover', { issuer }),
    onSuccess: (r) => {
      setForm((f) => ({ ...f, ...r, idField: 'sub', emailField: 'email', nameField: 'name', emailVerifiedField: 'email_verified' }));
      toast.success(t('oauthAdmin.discovered'));
    },
    onError: (e) => toast.fromError(e),
  });
  const save = useMutation({
    mutationFn: () => {
      // 只提交表单字段（编辑时 form 里还带着列表数据的 icon、hasSecret 等）
      const fields = Object.fromEntries(Object.keys(blank).map((k) => [k, form[k as keyof Form]])) as Form;
      const body = { ...fields, clientSecret: form.clientSecret || undefined, icon: iconBody(icon) };
      return existing ? api.put<OAuthAdminValue>(`/admin/settings/oauth/custom/${encodeURIComponent(existing.id)}`, body) : api.post<OAuthAdminValue>('/admin/settings/oauth/custom', body);
    },
    onSuccess: (d) => {
      onSaved(d);
      toast.success(existing ? t('oauthAdmin.saved') : t('oauthAdmin.added'));
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });

  return (
    <Modal
      open={!!state}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? t('oauthAdmin.editTitle', { name: existing.name }) : t('oauthAdmin.add')}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('oauthAdmin.name')} required description={t('oauthAdmin.nameHint')}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('oauthAdmin.namePlaceholder')} />
          </FormField>
          <FormField label={t('oauthAdmin.id')} required description={existing ? t('oauthAdmin.idLocked') : t('oauthAdmin.idHint')}>
            <Input className="font-mono text-xs" value={form.id} disabled={!!existing} onChange={(e) => set('id', e.target.value)} placeholder="sso" />
          </FormField>
        </div>
        <FormField label={t('oauthAdmin.icon')} description={t('oauthAdmin.iconHint')}>
          <IconPicker name={form.name} current={existing?.icon ?? null} value={icon} onChange={setIcon} />
        </FormField>
        <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} label={t('oauthAdmin.enableCustom')} />
        <FormField label={t('oauthAdmin.callback')} description={t('oauthAdmin.callbackHint')}>
          <div className="flex items-center gap-2">
            <Input readOnly className="font-mono text-xs" value={callback} onFocus={(e) => e.target.select()} />
            <Button disabled={!form.id} onClick={async () => (await copyText(callback)) && toast.success(t('common.copied'))}>
              {t('common.copy')}
            </Button>
          </div>
        </FormField>

        <div className="rounded-lg bg-surface-2 p-3 ring-1 ring-line">
          <div className="mb-2 text-[13px] font-medium">{t('oauthAdmin.discoverTitle')}</div>
          <div className="flex gap-2">
            <Input className="font-mono text-xs" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder={t('oauthAdmin.issuerPlaceholder')} />
            <Button disabled={!issuer.trim()} loading={discover.isPending} onClick={() => discover.mutate()}>
              {t('oauthAdmin.discover')}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-fg-3">{t('oauthAdmin.discoverHint')}</p>
        </div>

        <FormField label={t('oauthAdmin.authorizeUrl')} required>
          <Input className="font-mono text-xs" value={form.authorizeUrl} onChange={(e) => set('authorizeUrl', e.target.value)} placeholder="https://…/oauth2/authorize" />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('oauthAdmin.tokenUrl')} required>
            <Input className="font-mono text-xs" value={form.tokenUrl} onChange={(e) => set('tokenUrl', e.target.value)} placeholder="https://…/oauth2/token" />
          </FormField>
          <FormField label={t('oauthAdmin.userinfoUrl')} required>
            <Input className="font-mono text-xs" value={form.userinfoUrl} onChange={(e) => set('userinfoUrl', e.target.value)} placeholder="https://…/userinfo" />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Scope" description={t('oauthAdmin.scopeHint')}>
            <Input className="font-mono text-xs" value={form.scope} onChange={(e) => set('scope', e.target.value)} />
          </FormField>
          <FormField label={t('oauthAdmin.tokenAuth')}>
            <Select
              value={form.tokenAuth}
              onChange={(v) => set('tokenAuth', v)}
              options={[
                { value: 'post', label: t('oauthAdmin.tokenAuthPost'), description: 'client_secret_post' },
                { value: 'basic', label: t('oauthAdmin.tokenAuthBasic'), description: 'client_secret_basic' },
              ]}
            />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Client ID" required>
            <Input className="font-mono text-xs" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
          </FormField>
          <FormField label="Client Secret" required={!existing?.hasSecret} description={existing?.hasSecret ? t('oauthAdmin.secretKeep') : t('oauthAdmin.secretEncrypted')}>
            <PasswordInput
              className="font-mono text-xs"
              autoComplete="new-password"
              value={form.clientSecret}
              onChange={(e) => set('clientSecret', e.target.value)}
              placeholder={existing?.hasSecret ? '••••••••' : ''}
            />
          </FormField>
        </div>

        <div>
          <div className="mb-2 text-[13px] font-medium">{t('oauthAdmin.fieldsTitle')}</div>
          <p className="mb-3 text-xs text-fg-3">{t('oauthAdmin.fieldsDesc')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('oauthAdmin.idField')} required description={t('oauthAdmin.idFieldHint')}>
              <Input className="font-mono text-xs" value={form.idField} onChange={(e) => set('idField', e.target.value)} />
            </FormField>
            <FormField label={t('oauthAdmin.nameField')} description={t('oauthAdmin.nameFieldHint')}>
              <Input className="font-mono text-xs" value={form.nameField} onChange={(e) => set('nameField', e.target.value)} />
            </FormField>
            <FormField label={t('oauthAdmin.emailField')} description={t('oauthAdmin.emailFieldHint')}>
              <Input className="font-mono text-xs" value={form.emailField} onChange={(e) => set('emailField', e.target.value)} />
            </FormField>
            <FormField label={t('oauthAdmin.emailVerifiedField')} description={t('oauthAdmin.emailVerifiedFieldHint')}>
              <Input className="font-mono text-xs" value={form.emailVerifiedField} onChange={(e) => set('emailVerifiedField', e.target.value)} />
            </FormField>
          </div>
        </div>
        <div>
          <Switch checked={form.trustEmail} onCheckedChange={(v) => set('trustEmail', v)} label={t('oauthAdmin.trustEmail')} />
          <p className="mt-1.5 text-xs text-fg-3">{t('oauthAdmin.trustEmailHint')}</p>
        </div>
      </div>
    </Modal>
  );
}

/** 购买实例前必须绑定的第三方账号 */
export function OAuthRequirementCard({ value, onSaved }: { value: OAuthAdminValue; onSaved: (d: OAuthAdminValue) => void }) {
  const t = useT();
  const [providers, setProviders] = useState<string[]>(value.require.providers);
  const [mode, setMode] = useState(value.require.mode);
  useEffect(() => {
    setProviders(value.require.providers);
    setMode(value.require.mode);
  }, [value]);
  const toggle = (id: string, on: boolean) => setProviders((list) => (on ? [...list, id] : list.filter((x) => x !== id)));
  const save = useMutation({
    mutationFn: () => api.put<OAuthAdminValue>('/admin/settings/oauth-require', { providers, mode }),
    onSuccess: (d) => {
      onSaved(d);
      toast.success(t('oauthAdmin.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  // 已选但已停用的也列出来，方便取消勾选
  const list = value.providers.filter((p) => p.active || providers.includes(p.id));
  return (
    <Card>
      <CardHeader title={t('oauthAdmin.requireTitle')} />
      <CardBody>
        <p className="-mt-1 mb-2 text-[13px] text-fg-3">{t('oauthAdmin.requireDesc')}</p>
        <FormRow label={t('oauthAdmin.mustBind')} hint={list.length ? t('oauthAdmin.requireNone') : undefined}>
          {list.length ? (
            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1.5">
              {list.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={providers.includes(p.id)}
                  onCheckedChange={(v) => toggle(p.id, v)}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <span translate="no">{p.name}</span>
                      {!p.active && <span className="text-xs text-fg-3">{t('oauthAdmin.inactiveSuffix')}</span>}
                    </span>
                  }
                />
              ))}
            </div>
          ) : (
            <div className="pt-1.5 text-[13px] text-fg-3">{t('oauthAdmin.enableOneFirst')}</div>
          )}
        </FormRow>
        {providers.length > 1 && (
          <FormRow label={t('oauthAdmin.requireMode')}>
            <Segmented
              value={mode}
              onChange={setMode}
              items={[
                { value: 'any', label: t('oauthAdmin.requireAny') },
                { value: 'all', label: t('oauthAdmin.requireAll') },
              ]}
            />
          </FormRow>
        )}
        {providers.length > 0 && (
          <Alert tone="warning" className="mt-2">
            {t('oauthAdmin.requireWarn')}
          </Alert>
        )}
        <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
