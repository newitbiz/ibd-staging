/**
 * Email verification message templates (TEST/STAGING).
 * Invest in Bd (IBD).
 * No investment promises. Never include secrets beyond the one-time code/link.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedHeaderDataUri;
function emailHeaderDataUri() {
  if (cachedHeaderDataUri) return cachedHeaderDataUri;
  try {
    const png = readFileSync(join(__dirname, 'assets', 'ibd_email_header.png'));
    cachedHeaderDataUri = `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    cachedHeaderDataUri = '';
  }
  return cachedHeaderDataUri;
}

export function buildEmailVerificationMessage({ code, verifyUrl, expiresMinutes = 10 }) {
  const subject = 'Verify your Invest in Bd email';
  const text = [
    'Invest in Bd — TEST/STAGING',
    'https://investinbd.net · support@investinbd.net',
    '',
    'Use this 6-digit code to verify your email:',
    String(code),
    '',
    `Or open this one-time Verify Email link (expires in ${expiresMinutes} minutes):`,
    String(verifyUrl),
    '',
    'If you did not request this, ignore this email.',
    'Support: support@investinbd.net',
    'This is a private staging environment — not production.',
  ].join('\n');

  const safeCode = String(code).replace(/[^\d]/g, '').slice(0, 6);
  const safeUrl = String(verifyUrl).replace(/"/g, '&quot;');
  const headerUri = emailHeaderDataUri();
  const headerBlock = headerUri
    ? `<tr><td style="background:#0698AF;padding:16px 20px;text-align:center;">
          <img src="${headerUri}" alt="Invest in Bd" width="280" style="max-width:100%;height:auto;display:inline-block;" />
        </td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify your Invest in Bd email</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        ${headerBlock}
        <tr><td style="background:#b45309;color:#ffffff;padding:12px 20px;font-size:13px;font-weight:700;text-align:center;">
          Invest in Bd — TEST/STAGING
        </td></tr>
        <tr><td style="padding:28px 24px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">Verify your email</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#334155;">
            Enter this 6-digit code in the app, or tap the button below.
            The code and link expire in <strong>${expiresMinutes} minutes</strong>.
          </p>
          <p style="margin:0 0 20px;font-size:28px;letter-spacing:6px;font-weight:700;text-align:center;color:#0A7582;">
            ${safeCode}
          </p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${safeUrl}" style="display:inline-block;background:#0A7582;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;font-size:14px;">
              Verify Email
            </a>
          </p>
          <p style="margin:0;font-size:12px;line-height:1.5;color:#64748b;">
            If you did not request this, ignore this email. Support: support@investinbd.net. This message is for private staging only and does not contain investment offers or promises.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
