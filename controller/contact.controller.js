const { sendMailAsync } = require("../config/email");
const { secret } = require("../config/secret");

const BRAND = "Cotniva";
const THEME = "#4a1f1a";

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const adminInbox = () =>
  String(secret.admin_order_email || secret.email_user || "").trim();

const sanitize = (v, max) =>
  String(v || "")
    .trim()
    .slice(0, max);

/** POST /api/contact */
exports.submitContact = async (req, res, next) => {
  try {
    const name = sanitize(req.body?.name, 120);
    const email = sanitize(req.body?.email, 254).toLowerCase();
    const subject = sanitize(req.body?.subject, 200);
    const company = sanitize(req.body?.company, 120);
    const message = sanitize(req.body?.message, 5000);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name is required.",
      });
    }
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }
    if (!subject) {
      return res.status(400).json({
        success: false,
        message: "Subject is required.",
      });
    }
    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message is required.",
      });
    }

    const to = adminInbox();
    if (!to) {
      return res.status(503).json({
        success: false,
        message: "Contact inbox is not configured. Please try again later.",
      });
    }

    const mailSubject = `[Cotniva inquiry] ${subject}`;
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#f6f5f4;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f4;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:${THEME};padding:18px 24px;">
            <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:0.04em;">${BRAND}</div>
            <div style="color:#f3e8e6;font-size:13px;margin-top:4px;">New contact inquiry</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;color:#333;font-size:15px;line-height:1.65;">
            <p style="margin:0 0 12px;"><strong>Name:</strong> ${esc(name)}</p>
            <p style="margin:0 0 12px;"><strong>Email:</strong> ${esc(email)}</p>
            <p style="margin:0 0 12px;"><strong>Subject:</strong> ${esc(subject)}</p>
            ${
              company
                ? `<p style="margin:0 0 12px;"><strong>Company:</strong> ${esc(company)}</p>`
                : ""
            }
            <p style="margin:16px 0 8px;"><strong>Message:</strong></p>
            <p style="margin:0;white-space:pre-wrap;">${esc(message)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px 22px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.5;">
            Reply directly to this email to respond to the customer.
            <br/>© ${new Date().getFullYear()} ${BRAND}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    try {
      await sendMailAsync({
        to,
        replyTo: email,
        subject: mailSubject,
        html,
      });
    } catch (err) {
      console.error("[contact] inquiry email failed:", err?.message || err);
      return res.status(503).json({
        success: false,
        message:
          "Could not send your message right now. Please email us directly or try again shortly.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Thanks! We’ve received your message and will get back soon.",
    });
  } catch (error) {
    next(error);
  }
};
