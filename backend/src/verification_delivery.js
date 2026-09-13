/**
 * Verification delivery channel adapter.
 * EMAIL is enabled now; SMS is a stub for a later phase (not enabled).
 */

import { DomainError } from './domain.js';
import { buildEmailVerificationMessage } from './email/templates.js';

export class EmailVerificationDelivery {
  /**
   * @param {{ emailAdapter: { send: Function } }} deps
   */
  constructor({ emailAdapter }) {
    this.emailAdapter = emailAdapter;
  }

  get channel() {
    return 'email';
  }

  async sendVerification({ to, code, verifyUrl, expiresMinutes }) {
    const message = buildEmailVerificationMessage({ code, verifyUrl, expiresMinutes });
    await this.emailAdapter.send({
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { channel: 'email', delivered: true };
  }
}

/** SMS stub — kept for a future phase; never enabled on staging yet. */
export class SmsVerificationDeliveryStub {
  get channel() {
    return 'sms';
  }

  async sendVerification() {
    throw new DomainError(
      'SMS_NOT_ENABLED',
      'SMS verification is not enabled on this environment',
      501,
    );
  }
}

export function createVerificationDelivery({ emailAdapter, channel = 'email' } = {}) {
  if (channel === 'sms') {
    return new SmsVerificationDeliveryStub();
  }
  if (!emailAdapter) {
    throw new Error('emailAdapter is required for EMAIL verification delivery');
  }
  return new EmailVerificationDelivery({ emailAdapter });
}
