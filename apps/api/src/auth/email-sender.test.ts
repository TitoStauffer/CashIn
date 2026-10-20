import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailSenderFromEnvironment,
  SmtpEmailSender,
  UnconfiguredEmailSender,
} from "./email-sender.js";

const smtpConfiguration = {
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  username: "finance@example.com",
  password: "app-password-for-test",
  from: "finance@example.com",
};

test("SMTP sender creates a confirmation email with a text and HTML link", async () => {
  let sentMessage: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  } | undefined;
  const sender = new SmtpEmailSender(smtpConfiguration, async (message) => {
    sentMessage = message;
  });

  await sender.sendVerificationEmail(
    "new-user@example.com",
    "http://localhost:5173/verify-email?token=abc&source=email",
  );

  assert.equal(sentMessage?.from, "Saldo Certo <finance@example.com>");
  assert.equal(sentMessage?.to, "new-user@example.com");
  assert.equal(sentMessage?.subject, "Confirme seu e-mail - Saldo Certo");
  assert.match(sentMessage?.text ?? "", /token=abc&source=email/);
  assert.match(sentMessage?.html ?? "", /token=abc&amp;source=email/);
});

test("SMTP sender creates a wallet invitation email without altering the single-use URL", async () => {
  let sentMessage: { from: string; to: string; subject: string; text: string; html: string } | undefined;
  const sender = new SmtpEmailSender(smtpConfiguration, async (message) => { sentMessage = message; });
  const invitationUrl = "http://localhost:5173/wallet-invite?token=opaque-token&wallet=family";

  await sender.sendWalletInvitationEmail!(
    "member@example.com",
    invitationUrl,
    "Carteira Família",
    "owner@example.com",
  );

  assert.equal(sentMessage?.to, "member@example.com");
  assert.equal(sentMessage?.subject, "Convite para uma carteira compartilhada - Saldo Certo");
  assert.match(sentMessage?.text ?? "", /Carteira Família/);
  assert.match(sentMessage?.html ?? "", /Carteira Família/);
  assert.match(sentMessage?.html ?? "", /token=opaque-token&amp;wallet=family/);
  assert.doesNotMatch(sentMessage?.html ?? "", /<script/i);
});

test("email sender remains unconfigured when SMTP credentials are absent", async () => {
  const sender = createEmailSenderFromEnvironment({});

  assert.ok(sender instanceof UnconfiguredEmailSender);
  await assert.rejects(
    sender.sendVerificationEmail("new-user@example.com", "http://localhost/verify-email"),
    /Email sender is not configured/,
  );
});

test("email sender rejects partial SMTP credentials", () => {
  assert.throws(
    () => createEmailSenderFromEnvironment({ SMTP_USER: "finance@example.com" }),
    /SMTP_USER and SMTP_PASSWORD must both be configured/,
  );
});

test("email sender defaults to Gmail STARTTLS settings", () => {
  const sender = createEmailSenderFromEnvironment({
    SMTP_USER: "finance@example.com",
    SMTP_PASSWORD: "app-password-for-test",
  });

  assert.ok(sender instanceof SmtpEmailSender);
});
