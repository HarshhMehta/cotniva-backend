require("dotenv").config();
const nodemailer = require("nodemailer");
const { secret } = require("./secret");

let transporter;

const SMTP_TIMEOUT_MS = Math.max(
  8000,
  Number(process.env.SMTP_TIMEOUT_MS) || 20000
);

const getTransporter = () => {
  if (transporter) return transporter;

  const port = Number(secret.email_port || 587);
  const secure =
    secret.email_secure === true ||
    secret.email_secure === "true" ||
    port === 465;

  // Prefer host+port for Gmail app passwords; timeouts prevent order-flow hangs
  const config = {
    host: secret.email_host || "smtp.gmail.com",
    port,
    secure,
    auth: {
      user: secret.email_user,
      pass: String(secret.email_pass || "").replace(/\s+/g, ""),
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: { rejectUnauthorized: true },
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

  const sendPromise = getTransporter().sendMail({
    ...mailOptions,
    from,
  });

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`SMTP send timed out after ${SMTP_TIMEOUT_MS}ms`));
    }, SMTP_TIMEOUT_MS);
    if (typeof t.unref === "function") t.unref();
  });

  return Promise.race([sendPromise, timeoutPromise]);
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
module.exports.SMTP_TIMEOUT_MS = SMTP_TIMEOUT_MS;
