/**
 * Offline verification for requireAdmin authorization + critical invariants.
 * Does not hit MongoDB, Razorpay, or SMTP.
 */
const assert = require("assert");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const adminPath = require.resolve("../model/Admin");
const authPath = require.resolve("../config/auth");

const fakeAdmins = new Map();

require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    findById: (id) => ({
      select: async () => fakeAdmins.get(String(id)) || null,
    }),
  },
};

delete require.cache[authPath];
const { requireAdmin } = require("../config/auth");
const { secret } = require("../config/secret");

assert.ok(secret.token_secret, "TOKEN_SECRET must be set in env for this check");

const adminId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const customerId = "bbbbbbbbbbbbbbbbbbbbbbbb";
fakeAdmins.set(adminId, {
  _id: adminId,
  name: "Admin",
  email: "admin@test.com",
  role: "Admin",
  status: "Active",
});

const adminToken = jwt.sign(
  { _id: adminId, email: "admin@test.com", role: "Admin" },
  secret.token_secret
);
const customerToken = jwt.sign(
  { _id: customerId, email: "user@test.com", role: "user", type: "access" },
  secret.token_secret
);

const runMw = (token) =>
  new Promise((resolve) => {
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body, user: req.user });
        return this;
      },
      send(body) {
        resolve({ status: this.statusCode, body, user: req.user });
        return this;
      },
    };
    requireAdmin(req, res, () => {
      resolve({ status: 200, body: { ok: true }, user: req.user });
    });
  });

(async () => {
  const adminResult = await runMw(adminToken);
  assert.strictEqual(adminResult.status, 200, "admin should pass");
  assert.strictEqual(adminResult.user.email, "admin@test.com");

  const customerResult = await runMw(customerToken);
  assert.strictEqual(customerResult.status, 403, "customer must get 403");
  assert.match(String(customerResult.body.message), /Admin access required/i);

  const missing = await runMw(null);
  assert.strictEqual(missing.status, 401, "missing token → 401");

  const email = require("../services/order-email.service");
  assert.strictEqual(typeof email.beginEmailSend, "function");
  assert.strictEqual(typeof email.completeEmailSend, "function");
  assert.strictEqual(typeof email.failEmailSend, "function");

  const routes = fs.readFileSync(
    path.join(__dirname, "../routes/order.routes.js"),
    "utf8"
  );
  assert.match(routes, /requireAdmin,\s*updateOrderStatus/);
  assert.match(routes, /requireAdmin,\s*emergencyCancelOrder/);
  assert.match(routes, /requireAdmin,\s*updateAdminNotes/);
  assert.match(routes, /requireAdmin,\s*syncRazorpayAddress/);
  assert.doesNotMatch(routes, /isAuth,\s*updateOrderStatus/);

  const controller = fs.readFileSync(
    path.join(__dirname, "../controller/order.controller.js"),
    "utf8"
  );
  assert.match(controller, /safeAutoRefundPayment/);
  assert.match(controller, /OUT_OF_STOCK/);
  assert.match(controller, /acquirePersistLock/);
  assert.match(controller, /applyRazorpayRefundWebhook/);
  assert.doesNotMatch(controller, /const refundPayment\s*=/);
  assert.match(controller, /status:\s*"confirmed"/);
  assert.match(controller, /paymentStatus:\s*"paid"/);

  const refundSvc = fs.readFileSync(
    path.join(__dirname, "../services/razorpay-refund.service.js"),
    "utf8"
  );
  assert.match(refundSvc, /safeAutoRefundPayment/);
  assert.match(refundSvc, /refundPaidOrder/);
  assert.match(refundSvc, /order_exists/);

  const migrate = fs.readFileSync(
    path.join(__dirname, "migrate-order-statuses.js"),
    "utf8"
  );
  assert.match(migrate, /hasReliablePaidEvidence/);
  assert.match(migrate, /hasStoredPaymentId/);
  assert.doesNotMatch(migrate, /paymentMethod && \/razorpay/);

  console.log("ALL OFFLINE CHECKS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
