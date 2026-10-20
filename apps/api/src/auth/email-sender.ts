import nodemailer from "nodemailer";
import type { EmailSender } from "./auth.types.js";

export interface SmtpEmailConfiguration {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
}

interface VerificationEmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface WalletInvitationEmailMessage extends VerificationEmailMessage {}

type SendMail = (message: VerificationEmailMessage) => Promise<void>;

export class UnconfiguredEmailSender implements EmailSender {
  async sendVerificationEmail(_email: string, _confirmationUrl: string): Promise<void> {
    throw new Error("Email sender is not configured");
  }

  async sendWalletInvitationEmail(
    _email: string,
    _invitationUrl: string,
    _walletName: string,
    _inviterEmail: string,
  ): Promise<void> {
    throw new Error("Email sender is not configured");
  }
}

export class SmtpEmailSender implements EmailSender {
  private readonly sendMail: SendMail;
  private readonly fromAddress: string;

  constructor(configuration: SmtpEmailConfiguration, sendMail?: SendMail) {
    this.fromAddress = configuration.from;
    this.sendMail = sendMail ?? createSmtpSendMail(configuration);
  }

  async sendVerificationEmail(email: string, confirmationUrl: string): Promise<void> {
    const htmlUrl = escapeHtml(confirmationUrl);
    await this.sendMail({
      from: `Saldo Certo <${this.fromAddress}>`,
      to: email,
      subject: "Confirme seu e-mail - Saldo Certo",
      text: [
        "Olá!",
        "",
        "Para ativar sua conta no Saldo Certo, acesse o link abaixo:",
        confirmationUrl,
        "",
        "Se você não solicitou este cadastro, ignore esta mensagem.",
      ].join("\n"),
      html: [
        "<p>Olá!</p>",
        "<p>Para ativar sua conta no Saldo Certo, acesse o link abaixo:</p>",
        `<p><a href="${htmlUrl}">Confirmar meu e-mail</a></p>`,
        "<p>Se você não solicitou este cadastro, ignore esta mensagem.</p>",
      ].join(""),
    });
  }

  async sendWalletInvitationEmail(
    email: string,
    invitationUrl: string,
    walletName: string,
    inviterEmail: string,
  ): Promise<void> {
    const safeUrl = escapeHtml(invitationUrl);
    const safeWalletName = escapeHtml(walletName);
    const safeInviterEmail = escapeHtml(inviterEmail);
    const message: WalletInvitationEmailMessage = {
      from: `Saldo Certo <${this.fromAddress}>`,
      to: email,
      subject: "Convite para uma carteira compartilhada - Saldo Certo",
      text: [
        `Você recebeu um convite de ${inviterEmail} para acessar a carteira "${walletName}" no Saldo Certo.`,
        "",
        "Para aceitar o convite, acesse o link abaixo:",
        invitationUrl,
        "",
        "Se você não esperava este convite, ignore esta mensagem.",
      ].join("\n"),
      html: [
        `<p>Você recebeu um convite de ${safeInviterEmail} para acessar a carteira <strong>${safeWalletName}</strong> no Saldo Certo.</p>`,
        `<p><a href="${safeUrl}">Visualizar e aceitar convite</a></p>`,
        "<p>Se você não esperava este convite, ignore esta mensagem.</p>",
      ].join(""),
    };
    await this.sendMail(message);
  }
}

function createSmtpSendMail(configuration: SmtpEmailConfiguration): SendMail {
  const transporter = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    requireTLS: !configuration.secure,
    auth: {
      user: configuration.username,
      pass: configuration.password,
    },
  });

  return async (message) => {
    await transporter.sendMail(message);
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function createEmailSenderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EmailSender {
  const username = environment.SMTP_USER?.trim();
  const password = environment.SMTP_PASSWORD;

  if (!username && !password) return new UnconfiguredEmailSender();
  if (!username || !password) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must both be configured");
  }

  const port = parsePort(environment.SMTP_PORT);
  const secure = parseSecure(environment.SMTP_SECURE, port);

  return new SmtpEmailSender({
    host: environment.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure,
    username,
    password,
    from: environment.SMTP_FROM?.trim() || username,
  });
}

function parsePort(value: string | undefined): number {
  if (!value) return 587;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid TCP port");
  }
  return port;
}

function parseSecure(value: string | undefined, port: number): boolean {
  if (!value) return port === 465;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error("SMTP_SECURE must be true or false");
}
