import nodemailer from "nodemailer";
import type { SmtpConfig } from "../config.js";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<boolean>;
}

export interface MailerLogger {
  warn: (obj: unknown, message: string) => void;
}

let activeMailer: Mailer | null = null;

/** app 启动时注入；测试可替换为记录型 fake。 */
export function setMailer(mailer: Mailer | null): void {
  activeMailer = mailer;
}

export function getMailer(): Mailer | null {
  return activeMailer;
}

/**
 * 标准 SMTP 发送器（nodemailer）。
 * 失败只记录日志并返回 false，绝不向上抛：邮件是通知的旁路，不能影响 API。
 */
export function createMailer(config: SmtpConfig, logger: MailerLogger): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass
      ? { auth: { user: config.user, pass: config.pass } }
      : {}),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });

  return {
    async send(mail: OutgoingMail): Promise<boolean> {
      try {
        await transport.sendMail({
          from: config.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
        });
        return true;
      } catch (error) {
        logger.warn({ err: error, to: mail.to }, "smtp send failed");
        return false;
      }
    },
  };
}
