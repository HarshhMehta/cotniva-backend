require("dotenv").config();
const nodemailer = require("nodemailer");
const { secret } = require("./secret");

const SMTP_TIMEOUT_MS = Math.max(
  8000,
  Number(process.env.SMTP_TIMEOUT_MS) || 30000
);

const basePort = Number(secret.email_port || 587);
const baseSecure =
  secret.email_secure === true ||
  secret.email_secure === "true" ||
  basePort === 465;

const buildTransportConfig = ({ port, secure }) => {
  const config = {
    host: secret.email_host || "smtp.gmail.com",
    port,
    secure,
    auth: {
      user: secret.email_user,
      pass: String(secret.email_pass || "").replace(/\s+/g, ""),
    },
    pool: false,
    maxConnections: 1,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: Math.min(15000, SMTP_TIMEOUT_MS),
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: { rejectUnauthorized: true },
  };
  if (!secure && port === 587) {
    config.requireTLS = true;
  }
  return config;
};

/** Primary env port, then Gmail alternate (Render often blocks 587 or 465). */
const smtpAttempts = () => {
  const primary = { port: basePort, secure: baseSecure };
  const alt =
    basePort === 465
      ? { port: 587, secure: false }
      : { port: 465, secure: true };
  if (primary.port === alt.port) return [primary];
  return [primary, alt];
};

const timeoutError = (ms) =>
  new Promise((_, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`SMTP send timed out after ${ms}ms`));
    }, ms);
    if (typeof t.unref === "function") t.unref();
  });

const sendWithTransporter = async (transporter, mail) => {
  try {
    return await Promise.race([
      transporter.sendMail(mail),
      timeoutError(SMTP_TIMEOUT_MS),
    ]);
  } finally {
    try {
      transporter.close();
    } catch {
      /* ignore */
    }
  }
};

/** Fire-and-forget / awaitable send — does not touch Express `res` */
const sendMailAsync = async (mailOptions = {}) => {
  if (!secret.email_user || !secret.email_pass) {
    throw new Error("SMTP is not configured (EMAIL_USER / EMAIL_PASS)");
  }

  const from =
    mailOptions.from || `"Cotniva" <${secret.email_user}>`;
  const payload = { ...mailOptions, from };

  let lastError;
  for (const attempt of smtpAttempts()) {
    const transporter = nodemailer.createTransport(
      buildTransportConfig(attempt)
    );
    try {
      const info = await sendWithTransporter(transporter, payload);
      if (attempt.port !== basePort) {
        console.warn(
          `[smtp] sent via fallback ${secret.email_host || "smtp.gmail.com"}:${attempt.port}`
        );
      }
      return info;
    } catch (err) {
      lastError = err;
      console.warn(
        `[smtp] ${secret.email_host || "smtp.gmail.com"}:${attempt.port} failed: ${err.message}`
      );
    }
  }

  throw lastError || new Error("SMTP send failed");
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
module.exports.SMTP_TIMEOUT_MS = SMTP_TIMEOUT_MS;
