const crypto = require("crypto");

const RESET_TTL_MS = 10 * 60 * 1000;

const hashResetToken = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

/** Returns raw token (for email link only) + fields to persist on user/admin doc */
const createPasswordResetFields = () => {
  const rawToken = crypto.randomBytes(32).toString("hex");
  return {
    rawToken,
    passwordResetToken: hashResetToken(rawToken),
    passwordResetExpires: new Date(Date.now() + RESET_TTL_MS),
  };
};

const findByPasswordResetToken = async (Model, rawToken) => {
  if (!rawToken || String(rawToken).length < 16) return null;
  const hash = hashResetToken(rawToken);
  return Model.findOne({
    passwordResetToken: hash,
    passwordResetExpires: { $gt: new Date() },
  });
};

const clearPasswordResetFields = (doc) => {
  if (!doc) return;
  doc.passwordResetToken = undefined;
  doc.passwordResetExpires = undefined;
  if (doc.confirmationToken !== undefined) {
    doc.confirmationToken = undefined;
    doc.confirmationTokenExpires = undefined;
  }
};

module.exports = {
  RESET_TTL_MS,
  hashResetToken,
  createPasswordResetFields,
  findByPasswordResetToken,
  clearPasswordResetFields,
};
