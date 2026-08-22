/**
 * Unit tests for checkout pricing helpers (no Mongo required).
 */
const assert = require("assert");
const {
  offerUnitPrice,
  resolveShippingCostRupees,
  toPaise,
} = require("../services/checkout-pricing.service");

assert.strictEqual(offerUnitPrice(1000, 10), 900);
assert.strictEqual(offerUnitPrice(1000, 0), 1000);
assert.strictEqual(offerUnitPrice(-5, 10), 0);

assert.strictEqual(
  resolveShippingCostRupees(500, { deliveryCharge: 90, freeShippingAbove: 1299 }),
  90
);
assert.strictEqual(
  resolveShippingCostRupees(1299, { deliveryCharge: 90, freeShippingAbove: 1299 }),
  0
);
assert.strictEqual(
  resolveShippingCostRupees(2000, { deliveryCharge: 90, freeShippingAbove: 1299 }),
  0
);

assert.strictEqual(toPaise(10.555), 1056);
assert.strictEqual(toPaise(1999), 199900);

console.log("checkout-pricing helpers: ok");
