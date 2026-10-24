import nodemailer from 'nodemailer';
import type { EmailConfig } from '@/lib/payments/config';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
  /** Connects and signs in to the mail server without sending anything. */
  verify(): Promise<void>;
}

export function createMailer(config: EmailConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(m) {
      await transport.sendMail({ from: config.from, to: m.to, subject: m.subject, text: m.text, html: m.html, ...(m.replyTo ? { replyTo: m.replyTo } : {}) });
    },
    async verify() {
      await transport.verify();
    },
  };
}
