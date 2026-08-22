/**
 * Admin session cookie contract (no HTTP server).
 */
const assert = require("assert");
const {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
} = require("../services/admin-session.service");

assert.strictEqual(ADMIN_ACCESS_COOKIE, "cotniva_admin_access");
assert.strictEqual(ADMIN_REFRESH_COOKIE, "cotniva_admin_refresh");
assert.ok(!ADMIN_ACCESS_COOKIE.includes("admin="));
assert.ok(!ADMIN_REFRESH_COOKIE.includes("token"));

const readAdminAccessFromRequest = (req) =>
  req.cookies?.[ADMIN_ACCESS_COOKIE] || null;

assert.strictEqual(
  readAdminAccessFromRequest({ cookies: { cotniva_admin_access: "abc" } }),
  "abc"
);
assert.strictEqual(
  readAdminAccessFromRequest({
    cookies: {},
    headers: { authorization: "Bearer stolen" },
  }),
  null
);

console.log("admin-session: ok");
