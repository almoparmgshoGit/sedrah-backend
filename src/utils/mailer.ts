import nodemailer from 'nodemailer';
import { pool } from '../config/db';

export interface EmailVariables {
  company_name?: string;
  platform_name?: string;
  code?: string;
  verification_code?: string;
  user_name?: string;
  reset_link?: string;
  support_email?: string;
  [key: string]: any;
}

/**
 * Replace placeholders like {{variable}} or {{ variable }} in a template string
 */
export function replaceEmailPlaceholders(template: string, variables: EmailVariables): string {
  if (!template) return '';
  
  const now = new Date();
  const mergedVariables: Record<string, string> = {
    company_name: variables.company_name || variables.platform_name || 'سدرة',
    platform_name: variables.platform_name || variables.company_name || 'سدرة',
    appName: variables.company_name || variables.platform_name || 'سدرة',
    code: variables.code || variables.verification_code || '',
    verification_code: variables.verification_code || variables.code || '',
    verificationCode: variables.verification_code || variables.code || '',
    user_name: variables.user_name || 'العميل الكريم',
    userName: variables.user_name || 'العميل الكريم',
    reset_link: variables.reset_link || '#',
    resetLink: variables.reset_link || '#',
    support_email: variables.support_email || 'support@sdra.com',
    current_year: String(now.getFullYear()),
    ...variables,
  };

  let rendered = template;
  for (const [key, val] of Object.entries(mergedVariables)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
    rendered = rendered.replace(regex, String(val ?? ''));
  }

  return rendered;
}

/**
 * Helper to fetch settings from DB
 */
export async function getSmtpSettings(): Promise<Record<string, string>> {
  try {
    const res = await pool.query('SELECT key, value FROM settings');
    const settings: Record<string, string> = {};
    for (const row of res.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  } catch (err) {
    console.error('Failed to load SMTP settings from DB:', err);
    return {};
  }
}

/**
 * Send an email using configured SMTP and template
 */
export async function sendPlatformEmail({
  to,
  templateKey,
  variables = {},
  fallbackSubject,
  fallbackHtml,
}: {
  to: string;
  templateKey?: 'verification' | 'reset' | 'welcome' | string;
  variables?: EmailVariables;
  fallbackSubject?: string;
  fallbackHtml?: string;
}): Promise<boolean> {
  try {
    const settings = await getSmtpSettings();

    if (settings.smtp_enabled !== 'true') {
      console.log(`[Mailer] SMTP is disabled. Skipping sending email to ${to}`);
      return false;
    }

    if (!settings.smtp_host || !settings.smtp_port) {
      console.warn('[Mailer] Missing SMTP host or port.');
      return false;
    }

    const platformName = settings.platform_name || 'منصة سدرة';
    variables.company_name = variables.company_name || platformName;
    variables.platform_name = variables.platform_name || platformName;
    variables.support_email = variables.support_email || settings.support_email || 'support@sdra.com';

    let subject = fallbackSubject || `${platformName} - إشعار جديد`;
    let html = fallbackHtml || '<p>مرحباً بك في المنصة</p>';

    if (templateKey && settings.email_templates) {
      try {
        const templates = typeof settings.email_templates === 'string'
          ? JSON.parse(settings.email_templates)
          : settings.email_templates;

        const targetTemplate = templates[templateKey];
        if (targetTemplate && targetTemplate.enabled !== false) {
          if (targetTemplate.subject) {
            subject = targetTemplate.subject;
          }
          if (targetTemplate.body || targetTemplate.html) {
            html = targetTemplate.body || targetTemplate.html;
          }
        }
      } catch (parseErr) {
        console.error('[Mailer] Failed to parse email_templates JSON:', parseErr);
      }
    }

    // Replace all variables
    const finalSubject = replaceEmailPlaceholders(subject, variables);
    const finalHtml = replaceEmailPlaceholders(html, variables);

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: Number(settings.smtp_port),
      secure: settings.smtp_secure === 'true' || Number(settings.smtp_port) === 465,
      auth: settings.smtp_user && settings.smtp_pass ? {
        user: settings.smtp_user,
        pass: settings.smtp_pass,
      } : undefined,
    });

    await transporter.sendMail({
      from: `"${settings.smtp_from_name || platformName}" <${settings.smtp_from_email || settings.smtp_user || 'noreply@sdra.com'}>`,
      replyTo: settings.smtp_reply_to || settings.support_email || undefined,
      to,
      subject: finalSubject,
      html: finalHtml,
    });

    return true;
  } catch (error) {
    console.error('[Mailer] Error sending platform email:', error);
    return false;
  }
}
