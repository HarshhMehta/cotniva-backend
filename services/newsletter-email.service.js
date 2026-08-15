const { sendMailAsync } = require("../config/email");
const { secret } = require("../config/secret");

const BRAND = "Cotniva";
const THEME = "#4a1f1a";

const CONCURRENCY = Math.max(
  1,
  Math.min(5, Number(process.env.NEWSLETTER_SEND_CONCURRENCY) || 3)
);

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const storeUrl = () =>
  String(secret.client_url || "https://cotniva.vercel.app").replace(/\/$/, "");

/** Plain text → safe HTML paragraphs */
const contentToHtml = (content) => {
  const raw = String(content || "").trim();
  if (!raw) return "";
  return raw
    .split(/\n{2,}/)
    .map((block) => {
      const lines = esc(block).replace(/\n/g, "<br/>");
      return `<p style="margin:0 0 14px;color:#333;font-size:15px;line-height:1.65;">${lines}</p>`;
    })
    .join("");
};

const layout = ({ title, preheader, bodyHtml, footerExtraHtml = "" }) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#f6f5f4;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f4;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:${THEME};padding:18px 24px;">
            <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:0.04em;">${BRAND}</div>
            <div style="color:#f3e8e6;font-size:13px;margin-top:4px;">${esc(title)}</div>
          </td>
        </tr>
        <tr><td style="padding:24px;">${bodyHtml}</td></tr>
        <tr>
          <td style="padding:16px 24px 22px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.5;">
            ${footerExtraHtml}
            Need help? Write to ${esc(secret.email_user || "teamcotniva@gmail.com")}.
            <br/>© ${new Date().getFullYear()} ${BRAND}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const sendOrThrow = async (label, mail) => {
  const info = await sendMailAsync(mail);
  console.log(`[newsletter-email] ${label} → ${mail.to} (${info.messageId || "ok"})`);
  return info;
};

const sendVerificationEmail = async ({ email, verifyToken }) => {
  const link = `${storeUrl()}/newsletter/verify/${encodeURIComponent(verifyToken)}`;
  const html = layout({
    title: "Confirm your subscription",
    preheader: "Confirm your Cotniva newsletter subscription",
    bodyHtml: `
      <p style="margin:0 0 14px;color:#333;font-size:15px;line-height:1.65;">
        Thanks for joining Cotniva. Please confirm your email so we can send you
        early looks at new cotton kurtis — nothing else.
      </p>
      <p style="margin:24px 0;" align="center">
        <a href="${esc(link)}"
           style="display:inline-block;background:${THEME};color:#fff;text-decoration:none;padding:12px 22px;border-radius:4px;font-size:14px;font-weight:600;">
          Confirm subscription
        </a>
      </p>
      <p style="margin:0;color:#888;font-size:12px;line-height:1.5;">
        Or paste this link into your browser:<br/>
        <a href="${esc(link)}" style="color:${THEME};word-break:break-all;">${esc(link)}</a>
      </p>
      <p style="margin:16px 0 0;color:#888;font-size:12px;">
        If you didn’t request this, you can ignore this email.
      </p>
    `,
  });

  await sendOrThrow("verify", {
    to: email,
    subject: "Confirm your Cotniva newsletter subscription",
    html,
  });
};

const unsubscribeFooter = (unsubscribeToken) => {
  if (!unsubscribeToken) return "";
  const link = `${storeUrl()}/newsletter/unsubscribe/${encodeURIComponent(
    unsubscribeToken
  )}`;
  return `
    <p style="margin:0 0 10px;">
      Don’t want these emails?
      <a href="${esc(link)}" style="color:${THEME};">Unsubscribe</a>
    </p>
  `;
};

const sendCampaignEmail = async ({
  email,
  subject,
  content,
  unsubscribeToken,
}) => {
  const html = layout({
    title: subject,
    preheader: subject,
    bodyHtml: contentToHtml(content),
    footerExtraHtml: unsubscribeFooter(unsubscribeToken),
  });

  await sendOrThrow("campaign", {
    to: email,
    subject: String(subject || "").trim() || `${BRAND} update`,
    html,
  });
};

/**
 * Run async work over items with limited concurrency.
 * Does not throw; returns { sent, failed, failures }.
 */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = { sent: 0, failed: 0, failures: [] };
  let idx = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = items[idx++];
      try {
        await worker(current);
        results.sent += 1;
      } catch (err) {
        results.failed += 1;
        results.failures.push({
          email: current?.email || "",
          error: err?.message || String(err),
          at: new Date(),
        });
        console.error(
          `[newsletter-email] send failed for ${current?.email}:`,
          err?.message || err
        );
      }
    }
  });

  await Promise.all(runners);
  return results;
};

module.exports = {
  BRAND,
  THEME,
  CONCURRENCY,
  esc,
  storeUrl,
  contentToHtml,
  layout,
  sendVerificationEmail,
  sendCampaignEmail,
  mapWithConcurrency,
  unsubscribeFooter,
};
