require("dotenv").config();
const nodemailer = require("nodemailer");
const { secret } = require("./secret");

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  const port = Number(secret.email_port || 587);
  const secure =
    secret.email_secure === true ||
    secret.email_secure === "true" ||
    port === 465;

  // Prefer host+port for Gmail app passwords; `service: gmail` also works
  const config = {
    host: secret.email_host || "smtp.gmail.com",
    port,
    secure,
    auth: {
      user: secret.email_user,
      pass: String(secret.email_pass || "").replace(/\s+/g, ""),
    },
  };

  if (!secure && port === 587) {
    config.requireTLS = true;
  }

  transporter = nodemailer.createTransport(config);
  return transporter;
};

/** Fire-and-forget / awaitable send — does not touch Express `res` */
const sendMailAsync = async (mailOptions = {}) => {
  if (!secret.email_user || !secret.email_pass) {
    throw new Error("SMTP is not configured (EMAIL_USER / EMAIL_PASS)");
  }

  const from =
    mailOptions.from ||
    `"Cotniva" <${secret.email_user}>`;

  const info = await getTransporter().sendMail({
    ...mailOptions,
    from,
  });
  return info;
};

/**
 * Legacy helper used by auth/admin password flows.
 * Sends email then responds on `res`.
 */
module.exports.sendEmail = (body, res, message) => {
  sendMailAsync(body)
    .then(() => {
      if (res && !res.headersSent) {
        res.send({ message });
      }
    })
    .catch((err) => {
      console.error("sendEmail:", err.message);
      if (res && !res.headersSent) {
        res.status(403).send({
          message: `Error happen when sending email ${err.message}`,
        });
      }
    });
};

module.exports.sendMailAsync = sendMailAsync;
module.exports.getTransporter = getTransporter;
