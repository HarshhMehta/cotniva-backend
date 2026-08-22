/**
 * Lightweight tests for product listing helpers (no DB).
 */
const assert = require("assert");
const {
  categoryToSlug,
  salePriceExpr,
  MAX_STOCK_CHECK_ITEMS,
} = require("../services/product-listing.service");

assert.strictEqual(categoryToSlug("Kurti & Top"), "kurti-top");
assert.strictEqual(salePriceExpr(1000, 10), 900);
assert.strictEqual(salePriceExpr(500, 0), 500);
assert.strictEqual(MAX_STOCK_CHECK_ITEMS, 50);

console.log("product-listing.test.js OK");
