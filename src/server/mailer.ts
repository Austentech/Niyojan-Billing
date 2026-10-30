/**
 * Email delivery via Nodemailer (SMTP).
 *
 * Credentials come exclusively from environment variables — never from source.
 * When SMTP is not configured the system reports `isSmtpConfigured() === false`
 * so callers can fall back to surfacing links in the server log instead of
 * pretending an email was delivered.
 */
import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { headers } from "next/headers";
import { BRAND, RESET_TOKEN_TTL_MIN } from "@/lib/constants";

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_HOST.trim() !== "");
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST!.trim(),
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_SECURE ?? "false") === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
        : undefined,
    });
  }
  return transporter;
}

/** Absolute application URL, preferring APP_URL, else derived from the request. */
export async function getBaseUrl(): Promise<string> {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return `${proto}://${host}`;
}

export interface MailResult {
  delivered: boolean;
  error?: string;
}

/** Send the administrator password-reset email. */
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<MailResult> {
  if (!isSmtpConfigured()) {
    return { delivered: false, error: "SMTP is not configured" };
  }
  try {
    const fromName = process.env.SMTP_FROM_NAME?.trim() || BRAND.name;
    const fromEmail = process.env.SMTP_FROM_EMAIL?.trim() || process.env.SMTP_USER!.trim();
    await getTransporter().sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject: `${BRAND.name} — Administrator password reset`,
      text: resetEmailText(resetUrl),
      html: resetEmailHtml(resetUrl),
    });
    return { delivered: true };
  } catch (error) {
    console.error("[mailer] password-reset delivery failed:", error instanceof Error ? error.message : error);
    return { delivered: false, error: error instanceof Error ? error.message : "Unknown SMTP error" };
  }
}

function resetEmailText(resetUrl: string): string {
  return [
    `${BRAND.name}`,
    `${BRAND.systemName}`,
    "",
    "A password reset was requested for your administrator account.",
    "",
    `Open the link below to choose a new password (valid for ${RESET_TOKEN_TTL_MIN} minutes, single use):`,
    resetUrl,
    "",
    "If you did not request this change, no action is required and your current password remains active.",
    "",
    `${BRAND.tagline}`,
  ].join("\n");
}

function resetEmailHtml(resetUrl: string): string {
  const esc = resetUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background-color:#f7f8fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f8fa;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background-color:#ffffff;border:1px solid #e7e9ed;border-radius:8px;">
        <tr><td style="padding:28px 32px 0 32px;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:0.18em;color:#707784;text-transform:uppercase;">${BRAND.name}</p>
          <div style="height:3px;width:56px;background-color:#a2753b;margin:12px 0 0 0;border-radius:2px;"></div>
        </td></tr>
        <tr><td style="padding:20px 32px 0 32px;">
          <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:19px;line-height:1.4;color:#202936;font-weight:600;">Reset your administrator password</h1>
          <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#707784;">
            A password reset was requested for your administrator account. The link below is valid for
            ${RESET_TOKEN_TTL_MIN} minutes and can be used once.
          </p>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <a href="${esc}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#ffffff;background-color:#1b2737;text-decoration:none;padding:12px 28px;border-radius:6px;">Choose a new password</a>
        </td></tr>
        <tr><td style="padding:0 32px 8px 32px;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#707784;word-break:break-all;">
            If the button does not work, copy this link into your browser:<br>${esc}
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px 28px 32px;border-top:1px solid #e7e9ed;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#707784;">
            If you did not request this change, ignore this email — your current password remains active.<br>
            <span style="color:#1b2737;font-weight:600;">${BRAND.tagline}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
