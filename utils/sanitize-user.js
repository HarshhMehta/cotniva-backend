/**
 * Strip secrets from user/admin documents before sending to clients.
 */

const USER_SECRET_FIELDS = [
  "password",
  "confirmationToken",
  "passwordResetToken",
  "passwordResetExpires",
  "refreshToken",
];

const publicUser = (user) => {
  if (!user) return null;
  const plain =
    typeof user.toObject === "function"
      ? user.toObject()
      : { ...(user._doc || user) };
  for (const key of USER_SECRET_FIELDS) {
    delete plain[key];
  }
  return plain;
};

const publicAdmin = (admin) => {
  if (!admin) return null;
  const plain =
    typeof admin.toObject === "function"
      ? admin.toObject()
      : { ...(admin._doc || admin) };
  delete plain.password;
  return plain;
};

const USER_POPULATE_SAFE = {
  path: "user",
  select: "-password -confirmationToken -passwordResetToken -passwordResetExpires",
};

module.exports = {
  publicUser,
  publicAdmin,
  USER_POPULATE_SAFE,
  USER_SECRET_FIELDS,
};
