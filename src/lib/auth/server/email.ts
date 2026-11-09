import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Transporter } from "nodemailer";

import { getServerEnv, isDevMailCaptureEnabled } from "@/lib/config/env";
import { logAuthEvent, logAuthError, SystemAuthError } from "@/lib/auth/errors";
import { BRAND, EMAIL_CHANGE_POLICY } from "@/lib/constants";
import { OTP_TTL_MINUTES } from "@/lib/auth/validation";

/**
 * Verification-code delivery via Nodemailer (SMTP).
 *
 * SECURITY
 *   * The OTP code appears ONLY in the email body — never in API responses,
 *     never in application logs, never client-side.
 *   * SMTP credentials are read from the server environment only.
 *   * DEVELOPMENT CONVENIENCE: with SMTP_DEV_CAPTURE=true and
 *     NODE_ENV != production, messages are written as .eml files into
 *     .dev-outbox/ instead of being sent. This exists so the full login flow
 *     can be exercised without a real SMTP account and is hard-disabled in
 *     production.
 */

let cachedTransporter: Transporter | null = null;

async function getTransporter(): Promise<Transporter> {
  if (cachedTransporter) return cachedTransporter;
  const env = getServerEnv();
  const nodemailer = await import("nodemailer");
  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE === "true",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return cachedTransporter;
}

function buildEmailBody(to: string, code: string) {
  const subject = `${BRAND.name} — your sign-in verification code`;
  const text =
    `Your ${BRAND.name} verification code is:\n\n${code}\n\n` +
    `It is valid for ${OTP_TTL_MINUTES} minutes and can be used once.\n` +
    `If you did not attempt to sign in, no action is required — the administrator account remains protected.\n` +
    `This is an automated message from an internal system. Do not reply.\n`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#202936;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f8fa;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border:1px solid #e7e9ed;">
        <tr><td style="background-color:#1b2737;padding:22px 28px;">
          <span style="font-size:16px;font-weight:bold;color:#ffffff;">Niyojan</span>
          <span style="font-size:10px;color:#a2753b;letter-spacing:3px;text-transform:uppercase;">&nbsp;Corporation</span>
        </td></tr>
        <tr><td style="height:3px;background-color:#a2753b;line-height:3px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#707784;">Two-step verification</p>
          <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#202936;">Enter this code to complete sign-in</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#707784;">
            Use the 8-character code below to verify your identity. It is valid for
            <strong style="color:#202936;">${OTP_TTL_MINUTES} minutes</strong> and can be used
            <strong style="color:#202936;">once</strong>.
          </p>
          <div style="margin:0 0 20px;padding:16px;background-color:#f7f8fa;border:1px solid #e7e9ed;text-align:center;">
            <span style="font-family:'Courier New',Courier,monospace;font-size:26px;font-weight:bold;letter-spacing:6px;color:#1b2737;">${code}</span>
          </div>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#707784;">
            Sent to ${to}. If you did not attempt to sign in, ignore this message —
            failed attempts are monitored and the system locks automatically.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e7e9ed;font-size:11px;color:#707784;">
          ${BRAND.systemName} · Internal system · Automated message — do not reply
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

function buildRawEml(from: string, to: string, subject: string, text: string, html: string): string {
  const boundary = `----=_part_${randomBytes(8).toString("hex")}`;
  const headers = [
    `From: ${BRAND.name} <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
  ].join("\r\n");
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return `${headers}${body}`;
}

/**
 * Send the verification code email. Throws SystemAuthError on failure —
 * the caller then fails the login step closed (a code that cannot be
 * delivered must not be left active).
 */
export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const env = getServerEnv();
  const { subject, text, html } = buildEmailBody(to, code);

  await deliverVerificationEmail(env, to, subject, text, html, "otp");
}

/* ============================================================================
 * EMAIL-CHANGE verification code (Phase 3 — Account Settings)
 * ----------------------------------------------------------------------------
 * Sent to the NEW address an administrator wants to activate. The address
 * only becomes the sign-in email after this code is consumed atomically by
 * account_consume_email_change(). Same secrecy rules as the sign-in code:
 * the code appears ONLY inside the email body.
 * ==========================================================================*/

function buildEmailChangeBody(newEmail: string, code: string) {
  const minutes = Math.round(EMAIL_CHANGE_POLICY.ttlSeconds / 60);
  const subject = `${BRAND.name} — confirm your new administrator email`;
  const text =
    `A request was made to change the ${BRAND.name} administrator sign-in email to this address.\n\n` +
    `Confirmation code:\n\n${code}\n\n` +
    `The code is valid for ${minutes} minutes and can be used once.\n` +
    `If you did not request this change, ignore this message — the current email stays active.\n` +
    `This is an automated message from an internal system. Do not reply.\n`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#202936;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f8fa;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border:1px solid #e7e9ed;">
        <tr><td style="background-color:#1b2737;padding:22px 28px;">
          <span style="font-size:16px;font-weight:bold;color:#ffffff;">Niyojan</span>
          <span style="font-size:10px;color:#a2753b;letter-spacing:3px;text-transform:uppercase;">&nbsp;Corporation</span>
        </td></tr>
        <tr><td style="height:3px;background-color:#a2753b;line-height:3px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#707784;">Email change confirmation</p>
          <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#202936;">Confirm your new administrator email</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#707784;">
            Use the 8-character code below to activate
            <strong style="color:#202936;">${newEmail}</strong>
            as the sign-in email. The code is valid for
            <strong style="color:#202936;">${minutes} minutes</strong> and can be used
            <strong style="color:#202936;">once</strong>.
          </p>
          <div style="margin:0 0 20px;padding:16px;background-color:#f7f8fa;border:1px solid #e7e9ed;text-align:center;">
            <span style="font-family:'Courier New',Courier,monospace;font-size:26px;font-weight:bold;letter-spacing:6px;color:#1b2737;">${code}</span>
          </div>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#707784;">
            If you did not request this change, ignore this message — the current
            administrator email stays active and no settings are modified.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e7e9ed;font-size:11px;color:#707784;">
          ${BRAND.systemName} · Internal system · Automated message — do not reply
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Send the email-change verification code to the NEW address. Throws
 * SystemAuthError on failure — the caller fails closed (an undeliverable
 * request is never left active).
 */
export async function sendEmailChangeCode(newEmail: string, code: string): Promise<void> {
  const env = getServerEnv();
  const { subject, text, html } = buildEmailChangeBody(newEmail, code);

  await deliverVerificationEmail(env, newEmail, subject, text, html, "email_change");
}

/* --- shared delivery (SMTP with development capture) ------------------------- */

async function deliverVerificationEmail(
  env: ReturnType<typeof getServerEnv>,
  to: string,
  subject: string,
  text: string,
  html: string,
  kind: "otp" | "email_change",
): Promise<void> {
  if (isDevMailCaptureEnabled(env)) {
    try {
      const outbox = path.resolve(process.cwd(), env.SMTP_DEV_OUTBOX);
      await mkdir(outbox, { recursive: true });
      const filename = `${Date.now()}-${randomBytes(4).toString("hex")}.eml`;
      const raw = buildRawEml(env.SMTP_FROM, to, subject, text, html);
      await writeFile(path.join(outbox, filename), raw, "utf8");
      logAuthEvent(`${kind}_email_captured_to_dev_outbox`, {
        file: filename,
        recipient_domain: to.split("@")[1] ?? "",
      });
      return;
    } catch (err) {
      logAuthError(`${kind}_email_dev_capture_failed`, err);
      throw new SystemAuthError("dev outbox write failed");
    }
  }

  try {
    const transporter = await getTransporter();
    await transporter.sendMail({
      from: `"${BRAND.name}" <${env.SMTP_FROM}>`,
      to,
      subject,
      text,
      html,
    });
    logAuthEvent(`${kind}_email_sent`, { recipient_domain: to.split("@")[1] ?? "" });
  } catch (err) {
    logAuthError(`${kind}_email_send_failed`, err);
    throw new SystemAuthError("smtp delivery failed");
  }
}
