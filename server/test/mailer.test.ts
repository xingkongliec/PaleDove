import { beforeEach, describe, expect, it, vi } from 'vitest';

const smtp = vi.hoisted(() => ({ verify: vi.fn(), send: vi.fn(), close: vi.fn(), create: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.create } }));
vi.mock('../src/config.ts', () => ({ config: { PANEL_URL: 'https://panel.example.com' } }));
vi.mock('../src/lib/prisma.ts', () => ({ prisma: {} }));
vi.mock('../src/lib/crypto.ts', () => ({ decrypt: (value: string) => `decoded:${value}`, randomToken: vi.fn(), sha256: vi.fn() }));
vi.mock('../src/lib/settings.ts', () => ({ getSetting: vi.fn(), getSettings: vi.fn() }));

import { getSetting, getSettings } from '../src/lib/settings.ts';
import { button, esc, escLines, htmlToText, mailLocale, quote, renderMail } from '../src/services/mail/mail-template.ts';
import { sendMail, sendTestEmail, setMailCapture, verifyMailConnection, type MailSettings } from '../src/services/mail/mailer.ts';

const mail: MailSettings = { enabled: true, host: 'smtp.example.com', port: 587, secure: false, user: 'smtp-user', passwordEnc: 'saved-secret', fromName: '', fromEmail: 'sender@example.com' };

beforeEach(() => {
  vi.resetAllMocks();
  setMailCapture(null);
  smtp.verify.mockResolvedValue(true);
  smtp.send.mockResolvedValue({ accepted: ['recipient@example.com'] });
  smtp.create.mockReturnValue({ verify: smtp.verify, sendMail: smtp.send, close: smtp.close });
  vi.mocked(getSetting).mockImplementation(async (key) => (key === 'mail' ? mail : { mime: '', data: '', source: '', updatedAt: '' }) as never);
  vi.mocked(getSettings).mockResolvedValue({ siteName: 'PaleDove' } as Awaited<ReturnType<typeof getSettings>>);
});

describe('mail templates and SMTP delivery', () => {
  it('escapes user-controlled content and preserves readable links in the text version', () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    const html = '<div style="display:none">Hidden preview</div><h1>Title</h1>' + quote(escLines('First line\n<Second line>')) + button('https://panel.example.com/?a="b"&token=123', 'Open <page>', 'en');
    expect(html).not.toContain('href="https://panel.example.com/?a="b"');
    const text = htmlToText(html);
    expect(text).not.toContain('Hidden preview');
    expect(text).toContain('First line\n<Second line>');
    expect(text).toContain('Open <page>（https://panel.example.com/?a="b"&token=123）');
    expect(text).not.toContain('<table');
  });

  it('uses the site brand, chosen language and email-compatible raster logos', async () => {
    vi.mocked(getSettings).mockResolvedValue({ siteName: '<Cloud & Company>' } as Awaited<ReturnType<typeof getSettings>>);
    const html = await renderMail({ title: '<Verify>', body: '<p>Safe content</p>', locale: 'en', baseUrl: 'https://other.example.com/' });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('&lt;Cloud &amp; Company&gt;');
    expect(html).toContain('&lt;Verify&gt;');
    expect(html).toContain('https://other.example.com/logo.png');
    expect(html).toContain('This email was sent automatically');
    vi.mocked(getSetting).mockResolvedValue({ mime: 'image/png', data: 'image-data', source: '', updatedAt: '2026-10-18T00:00:00Z' } as never);
    expect(await renderMail({ title: 'Verify', body: '', locale: 'zh-TW' })).toContain('/api/site/icon?v=');
    vi.mocked(getSetting).mockResolvedValue({ mime: 'image/svg+xml', data: 'svg-data', source: '', updatedAt: '' } as never);
    expect(await renderMail({ title: 'Verify', body: '' })).not.toContain('<img');
    expect(mailLocale('en-US')).toBe('en');
  });

  it('checks the SMTP connection and closes it on success or failure', async () => {
    await verifyMailConnection(mail);
    expect(smtp.verify).toHaveBeenCalledOnce();
    expect(smtp.send).not.toHaveBeenCalled();
    expect(smtp.close).toHaveBeenCalledOnce();
    smtp.verify.mockRejectedValueOnce(new Error('Authentication failed'));
    await expect(verifyMailConnection(mail)).rejects.toThrow('Authentication failed');
    expect(smtp.close).toHaveBeenCalledTimes(2);
  });

  it('uses unsaved sender and TLS settings while retaining the saved SMTP password', async () => {
    const draft = { ...mail, host: 'draft.example.com', port: 465, secure: true, fromName: 'Draft sender' };
    await sendTestEmail('recipient@example.com', draft, 'https://panel.example.com', 'en');
    expect(smtp.create).toHaveBeenCalledWith(expect.objectContaining({
      host: 'draft.example.com', port: 465, secure: true, auth: { user: 'smtp-user', pass: 'decoded:saved-secret' },
    }));
    const sent = smtp.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ from: { name: 'Draft sender', address: 'sender@example.com' }, to: 'recipient@example.com', subject: '[PaleDove] SMTP test email' });
    expect(sent.html).toContain('<table role="presentation"');
    expect(sent.text).toContain('SMTP is configured correctly');
    expect(sent.text).not.toContain('<table');
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it('supports SMTP without authentication and falls back to the site name', async () => {
    await sendMail('recipient@example.com', 'Test', '<p>Content</p>', { ...mail, user: '', passwordEnc: '' });
    expect(smtp.create).toHaveBeenCalledWith(expect.objectContaining({ secure: false, auth: undefined }));
    expect(smtp.send.mock.calls[0]![0].from.name).toBe('PaleDove');
  });

  it('does not report success when SMTP sending fails and always closes the connection', async () => {
    smtp.send.mockRejectedValueOnce(new Error('Sender rejected'));
    await expect(sendMail('recipient@example.com', 'Test', '<p>Content</p>')).rejects.toThrow('Sender rejected');
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it('returns false without opening a connection when email is disabled', async () => {
    expect(await sendMail('recipient@example.com', 'Test', '<p>Content</p>', { ...mail, enabled: false })).toBe(false);
    expect(smtp.create).not.toHaveBeenCalled();
  });
});
