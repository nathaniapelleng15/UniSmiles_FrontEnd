import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_DIR = path.join(__dirname, 'assets');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const PLACEHOLDER_VALUES = new Set([
  'your_email@gmail.com',
  'your_app_password_here',
  'your_password_here',
  'your_client_id.apps.googleusercontent.com',
  'your_client_secret',
  'your_refresh_token',
  're_your_resend_api_key',
]);

const readConfiguredEnv = (...names) => {
  for (const name of names) {
    const value = (process.env[name] || '').trim();
    if (value && !PLACEHOLDER_VALUES.has(value.toLowerCase())) return value;
  }
  return '';
};

class EmailError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || message;
  }
}

function encodeMimeHeader(str) {
  return `=?UTF-8?B?${Buffer.from(str, 'utf-8').toString('base64')}?=`;
}

function base64urlEncode(str) {
  return Buffer.from(str, 'utf-8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildMimeMessage(from, to, subject, html, attachments = []) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(html, 'utf-8').toString('base64'),
    '',
  ];

  for (const attachment of attachments) {
    let content;
    if (attachment.path) {
      content = fs.readFileSync(attachment.path);
    } else if (attachment.content) {
      const encoding = attachment.encoding === 'base64' ? 'base64' : 'utf-8';
      content = Buffer.from(attachment.content, encoding);
    } else {
      continue;
    }

    const ext = path.extname(attachment.filename).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : 'application/octet-stream';

    const disposition = attachment.cid ? 'inline' : 'attachment';
    const parts = [
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: ${disposition}; filename="${attachment.filename}"`,
    ];

    if (attachment.cid) {
      parts.push(`Content-ID: <${attachment.cid}>`);
    }

    parts.push(
      `Content-Transfer-Encoding: base64`,
      '',
      content.toString('base64'),
      ''
    );

    lines.push(...parts);
  }

  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

let gmailAccessToken = null;
let gmailTokenExpiry = 0;

async function getGmailAccessToken() {
  if (gmailAccessToken && Date.now() < gmailTokenExpiry) {
    return gmailAccessToken;
  }

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new EmailError('E_CONFIG', 'Gmail API credentials tidak lengkap. Periksa GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, dan GMAIL_REFRESH_TOKEN di .env');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new EmailError('EAUTH', data.error_description || data.error || 'Gagal mendapatkan access token Gmail');
  }

  gmailAccessToken = data.access_token;
  gmailTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return gmailAccessToken;
}

async function sendViaSMTP({ from, to, subject, html, attachments }) {
  const { user, pass, host, port, secure } = getEmailConfig();

  if (!user || !pass) {
    throw new EmailError('E_CONFIG', 'SMTP_USER/SMTP_PASS atau GMAIL_USER/GMAIL_APP_PASSWORD belum dikonfigurasi di environment server');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: true,
    },
    connectionTimeout: 10000,
    socketTimeout: 10000,
  });

  try {
    await transporter.verify();
  } catch (err) {
    if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      throw new EmailError('ECONNREFUSED', 'Tidak dapat terhubung ke server SMTP. Port 587/465 mungkin diblokir oleh hosting provider. Gunakan EMAIL_PROVIDER=gmail-api atau resend untuk hosting.');
    }
    throw err;
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      attachments: attachments.map(a => {
        const att = {
          filename: a.filename,
          cid: a.cid,
        };
        if (a.path) att.path = a.path;
        if (a.content) {
          att.content = a.content;
          att.encoding = a.encoding || 'base64';
        }
        return att;
      }),
    });
    return info;
  } catch (err) {
    if (err.code === 'EAUTH') {
      throw new EmailError('EAUTH', 'Autentikasi Gmail gagal. Pastikan App Password benar dan 2FA aktif di akun Gmail.');
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION') {
      throw new EmailError('ECONNREFUSED', 'Tidak dapat terhubung ke server email. Port SMTP diblokir. Gunakan EMAIL_PROVIDER=gmail-api atau resend untuk hosting.');
    }
    throw new EmailError(err.code || 'EUNKNOWN', err.message || 'Gagal mengirim email', err.message);
  }
}

async function sendViaGmailAPI({ from, to, subject, html, attachments }) {
  const accessToken = await getGmailAccessToken();

  const mimeMessage = buildMimeMessage(from, to, subject, html, attachments);
  const raw = base64urlEncode(mimeMessage);

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  const result = await response.json();
  if (!response.ok) {
    const errorMsg = result.error?.message || 'Gagal mengirim email via Gmail API';
    if (response.status === 401) {
      throw new EmailError('EAUTH', 'Akses Gmail ditolak. Periksa OAuth2 credentials dan refresh token.');
    }
    throw new EmailError('EUNKNOWN', errorMsg, result.error?.message);
  }

  return result;
}

async function sendViaResend({ from, to, subject, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new EmailError('E_CONFIG', 'RESEND_API_KEY belum dikonfigurasi di .env');
  }

  const resendAttachments = attachments.map(a => {
    const att = {
      filename: a.filename,
    };
    if (a.cid) att.content_id = a.cid;
    if (a.path) {
      att.content = fs.readFileSync(a.path).toString('base64');
    } else if (a.content) {
      att.content = a.content;
    }
    return att;
  });

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      attachments: resendAttachments,
    }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new EmailError('EUNKNOWN', result.message || 'Gagal mengirim email via Resend', result.message);
  }

  return result;
}

export function buildEmailHtml({ logoImgSrc, photoImgTag, downloadBtn }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Foto UniSmile</title>
</head>
<body style="margin:0;padding:0;background:#0c1633;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0c1633;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="100%" style="max-width:520px;background:#1b2b5a;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
          <tr>
            <td style="background:linear-gradient(135deg,#1b2b5a,#0c1633);padding:32px 24px;text-align:center;border-bottom:2px solid rgba(246,205,70,0.3);">
              <img src="${logoImgSrc}" alt="UniSmile Logo" style="height:48px;display:block;margin:0 auto 12px;border-radius:12px;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 24px;text-align:center;">
              <p style="color:rgba(255,255,255,0.9);font-size:16px;margin:0 0 8px;">Hei! Foto kamu sudah siap 🎉</p>
              <p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 24px;">Simpan foto kenangan kamu dari UniSmile Photo Booth</p>
              ${photoImgTag}
              ${downloadBtn}
            </td>
          </tr>
          <tr>
            <td style="background:rgba(0,0,0,0.3);padding:20px 24px;text-align:center;border-top:1px solid rgba(255,255,255,0.05);">
              <p style="color:rgba(255,255,255,0.3);font-size:11px;margin:0;">UniSmile Photo Booth • Ko+ Lab • Uni Inside</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function prepareEmailParts({ photoUrl, photoBase64 }) {
  const logoPath = path.join(ASSETS_DIR, 'LOGO UNI SMILE.png');
  const finalLogoPath = fs.existsSync(logoPath) ? logoPath : null;

  const attachments = [];
  let logoImgSrc = finalLogoPath
    ? 'cid:logo@unismile'
    : 'https://unismile-photobooth.nathaniapelleng15.workers.dev/assets/LOGO%20UNI%20SMILE.png';

  if (finalLogoPath) {
    attachments.push({
      filename: 'unismile-logo.png',
      path: finalLogoPath,
      cid: 'logo@unismile',
    });
  }

  let photoImgTag = '';
  let downloadBtn = '';
  const isLocalhost = photoUrl && (photoUrl.includes('localhost') || photoUrl.includes('127.0.0.1'));

  if (photoBase64) {
    const matches = photoBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) throw new EmailError('EINVALID', 'Format gambar base64 tidak valid');
    const mimeType = matches[1];
    const base64Data = matches[2];
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    attachments.push({
      filename: `unismile-photo.${ext}`,
      content: base64Data,
      encoding: 'base64',
      cid: 'photo@unismile',
    });
    photoImgTag = `
      <div style="background:#0c1633;border-radius:16px;padding:16px;margin-bottom:24px;border:1px solid rgba(255,255,255,0.1);">
        <img src="cid:photo@unismile" alt="Foto UniSmile" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;">
      </div>`;
    downloadBtn = `<p style="color:rgba(255,255,255,0.6);font-size:13px;margin:0 0 16px;">Foto terlampir di email ini sebagai file attachment 📎</p>`;
  } else if (isLocalhost) {
    const filename = photoUrl.split('/').pop();
    const localFilePath = path.join(UPLOAD_DIR, filename);
    attachments.push({
      filename,
      path: localFilePath,
      cid: 'photo@unismile',
    });
    photoImgTag = `
      <div style="background:#0c1633;border-radius:16px;padding:16px;margin-bottom:24px;border:1px solid rgba(255,255,255,0.1);">
        <img src="cid:photo@unismile" alt="Foto UniSmile" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;">
      </div>`;
    downloadBtn = `<p style="color:rgba(255,255,255,0.6);font-size:13px;margin:0 0 16px;">Karena server berjalan di Localhost, foto dilampirkan langsung di email ini sebagai attachment 📎</p>`;
  } else if (photoUrl) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(photoUrl)}`;
    photoImgTag = `
      <div style="background:#0c1633;border-radius:16px;padding:16px;margin-bottom:24px;border:1px solid rgba(255,255,255,0.1);">
        <img src="${photoUrl}" alt="Foto UniSmile" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;">
      </div>`;
    downloadBtn = `
      <a href="${photoUrl}" style="display:inline-block;background:#f6cd46;color:#0c1633;text-decoration:none;padding:16px 40px;border-radius:100px;font-weight:900;font-size:16px;letter-spacing:0.5px;margin-bottom:24px;">
        ⬇️ Download Foto
      </a>
      <div style="margin:0 auto 8px;display:inline-block;background:white;padding:12px;border-radius:12px;">
        <img src="${qrUrl}" alt="QR Code" width="140" height="140" style="display:block;">
      </div>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;margin:4px 0 0;">Scan QR untuk download</p>`;
  }

  const html = buildEmailHtml({ logoImgSrc, photoImgTag, downloadBtn });
  return { html, attachments };
}

export async function sendEmail({ from, to, subject, html, attachments }) {
  const provider = getEmailConfig().provider;

  switch (provider) {
    case 'resend':
      return sendViaResend({ from, to, subject, html, attachments });
    case 'gmail-api':
      return sendViaGmailAPI({ from, to, subject, html, attachments });
    case 'smtp':
    default:
      return sendViaSMTP({ from, to, subject, html, attachments });
  }
}

export function getEmailConfig() {
  const provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase().trim();
  const user = readConfiguredEnv('SMTP_USER', 'GMAIL_USER');
  const pass = readConfiguredEnv('SMTP_PASS', 'GMAIL_APP_PASSWORD').replace(/\s+/g, '');
  const host = readConfiguredEnv('SMTP_HOST') || 'smtp.gmail.com';
  const portValue = readConfiguredEnv('SMTP_PORT') || '587';
  const port = Number.parseInt(portValue, 10) || 587;
  const secureValue = readConfiguredEnv('SMTP_SECURE').toLowerCase();
  const secure = secureValue ? ['1', 'true', 'yes', 'on'].includes(secureValue) : port === 465;
  const sender = readConfiguredEnv('EMAIL_FROM', 'SMTP_USER', 'GMAIL_USER');
  const from = sender
    ? sender.includes('<')
      ? sender
      : `"UniSmile Photo Booth" <${sender}>`
    : 'UniSmile Photo Booth';

  return { provider, user, pass, host, port, secure, from };
}

export { EmailError };
