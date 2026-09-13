/**
 * Pluggable email delivery adapters.
 * - MemoryEmailAdapter: tests / local without SMTP
 * - SmtpEmailAdapter: staging/production via nodemailer
 */

import nodemailer from 'nodemailer';

export class MemoryEmailAdapter {
  constructor() {
    /** @type {Array<{to:string,subject:string,text:string,html:string,sentAt:string}>} */
    this.sent = [];
  }

  async send({ to, subject, text, html, replyTo }) {
    const message = {
      to: String(to),
      subject: String(subject || ''),
      text: String(text || ''),
      html: String(html || ''),
      replyTo: replyTo || 'support@investinbd.net',
      sentAt: new Date().toISOString(),
    };
    this.sent.push(message);
    return { messageId: `memory-${this.sent.length}` };
  }

  clear() {
    this.sent = [];
  }

  last() {
    return this.sent.at(-1) || null;
  }

  messagesTo(email) {
    const dest = String(email || '').toLowerCase();
    return this.sent.filter((m) => m.to.toLowerCase() === dest);
  }
}

export class SmtpEmailAdapter {
  constructor(config = {}) {
    this.host = config.host || process.env.SMTP_HOST;
    this.port = Number(config.port || process.env.SMTP_PORT || 587);
    this.username = config.username ?? process.env.SMTP_USERNAME ?? '';
    this.password = config.password ?? process.env.SMTP_PASSWORD ?? '';
    this.fromEmail = config.fromEmail || process.env.SMTP_FROM_EMAIL;
    this.fromName = config.fromName || process.env.SMTP_FROM_NAME || 'Invest in Bd';
    this.replyTo = config.replyTo || process.env.SMTP_REPLY_TO || 'support@investinbd.net';
    this.secure = config.secure ?? this.port === 465;
    this._transporter = null;
  }

  #assertConfigured() {
    if (!this.host || !this.fromEmail) {
      const err = new Error('SMTP is not configured');
      err.code = 'SMTP_MISCONFIGURED';
      throw err;
    }
  }

  #transporter() {
    if (this._transporter) return this._transporter;
    this.#assertConfigured();
    this._transporter = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth: this.username
        ? { user: this.username, pass: this.password }
        : undefined,
    });
    return this._transporter;
  }

  async send({ to, subject, text, html }) {
    this.#assertConfigured();
    const info = await this.#transporter().sendMail({
      from: `"${String(this.fromName).replace(/"/g, '')}" <${this.fromEmail}>`,
      replyTo: this.replyTo || undefined,
      to: String(to).trim(),
      subject: String(subject || ''),
      text: text || '',
      html: html || text || '',
    });
    return { messageId: info.messageId || `smtp-${Date.now()}` };
  }
}

/**
 * Factory: memory when EMAIL_ADAPTER=memory or SMTP_HOST unset; otherwise SMTP.
 * Never logs credentials.
 */
export function createEmailAdapter(options = {}) {
  const mode = String(options.mode || process.env.EMAIL_ADAPTER || '').toLowerCase();
  if (mode === 'memory' || (!process.env.SMTP_HOST && mode !== 'smtp')) {
    return new MemoryEmailAdapter();
  }
  return new SmtpEmailAdapter(options);
}
