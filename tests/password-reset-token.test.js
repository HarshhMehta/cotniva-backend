/**
 * Unit tests for password reset token helpers (no Mongo).
 */
const assert = require("assert");
const {
  createPasswordResetFields,
  hashResetToken,
  RESET_TTL_MS,
} = require("../utils/password-reset-token");

const reset = createPasswordResetFields();
assert.ok(reset.rawToken);
assert.strictEqual(reset.rawToken.length, 64);
assert.ok(reset.passwordResetToken);
assert.notStrictEqual(reset.rawToken, reset.passwordResetToken);
assert.ok(reset.passwordResetExpires instanceof Date);
assert.ok(reset.passwordResetExpires.getTime() > Date.now());
assert.ok(
  reset.passwordResetExpires.getTime() <= Date.now() + RESET_TTL_MS + 1000
);

const hash1 = hashResetToken(reset.rawToken);
assert.strictEqual(hash1, reset.passwordResetToken);

const jwt = require("jsonwebtoken");
const { tokenForVerify } = require("../config/auth");
const fakeUser = {
  _id: "507f1f77bcf86cd799439011",
  name: "Test",
  email: "t@example.com",
  password: "$2a$10$hashedpasswordvalue",
};
const verifyJwt = tokenForVerify(fakeUser);
const decoded = jwt.decode(verifyJwt);
assert.strictEqual(decoded.password, undefined);
assert.strictEqual(decoded.purpose, "email_verify");

console.log("password-reset-token: ok");
