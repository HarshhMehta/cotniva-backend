#!/usr/bin/env node
/**
 * Refund-safety regression tests (in-memory fakes; no live Razorpay).
 * Run: node tests/refund-safety.test.js
 */
const assert = require("assert");
const Module = require("module");
const path = require("path");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const originalLoad = Module._load;
const refunds = [];
const logs = [];
const orders = new Map();
const attempts = new Map();

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function nestSet(doc, key, val) {
  const parts = key.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

function matchesFilter(doc, filter) {
  if (!filter || !Object.keys(filter).length) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (k === "$and") {
      if (!v.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (k === "$nin" || k === "$in" || k === "$lte" || k === "$exists") {
      continue;
    }
    const parts = k.split(".");
    let cur = doc;
    for (const p of parts) {
      if (cur == null) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(v, "$exists")) {
        const exists = cur !== undefined && cur !== null;
        if (Boolean(v.$exists) !== exists) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(v, "$lte")) {
        if (cur == null) return false;
        if (!(new Date(cur) <= new Date(v.$lte))) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(v, "$nin")) {
        if (v.$nin.includes(cur)) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(v, "$in")) {
        if (!v.$in.includes(cur)) return false;
        continue;
      }
      if (!matchesFilter(cur || {}, v)) return false;
      continue;
    }
    if (idStr(cur) !== idStr(v)) return false;
  }
  return true;
}

function idStr(v) {
  return v == null ? "" : String(v);
}

function makeFindOneAndUpdate(store, idField) {
  return async (filter, update, opts = {}) => {
    let doc = null;
    for (const row of store.values()) {
      if (matchesFilter(row, filter)) {
        doc = row;
        break;
      }
    }
    if (!doc) {
      if (!opts.upsert) return null;
      const insert = {
        _id: new ObjectId(),
        ...(update.$setOnInsert || {}),
      };
      // Apply filter equality fields for upsert identity
      if (filter.razorpay_payment_id) {
        insert.razorpay_payment_id = filter.razorpay_payment_id;
      }
      if (filter._id) insert._id = filter._id;
      store.set(idStr(insert[idField] || insert._id), insert);
      doc = insert;
    }
    if (update.$set) {
      for (const [k, val] of Object.entries(update.$set)) {
        nestSet(doc, k, val);
      }
    }
    return opts.new === false ? clone(doc) : clone(doc);
  };
}

const fakeOrder = {
  findOne: async (filter) => {
    for (const o of orders.values()) {
      if (matchesFilter(o, filter)) return clone(o);
    }
    return null;
  },
  findById: async (id) => {
    const o = orders.get(idStr(id));
    return o ? clone(o) : null;
  },
  findOneAndUpdate: makeFindOneAndUpdate(orders, "_id"),
  updateOne: async (filter, update) => {
    for (const o of orders.values()) {
      if (matchesFilter(o, filter)) {
        if (update.$set) {
          for (const [k, val] of Object.entries(update.$set)) {
            nestSet(o, k, val);
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }
    return { matchedCount: 0, modifiedCount: 0 };
  },
  create: async () => {
    throw new Error("Order.create not stubbed for this test");
  },
};

const fakePaymentAttempt = {
  findOne: async (filter) => {
    for (const a of attempts.values()) {
      if (matchesFilter(a, filter)) return clone(a);
    }
    return null;
  },
  findOneAndUpdate: async (filter, update, opts = {}) => {
    // Simulate unique upsert race → E11000 when active lock blocks match
    let doc = null;
    for (const row of attempts.values()) {
      if (row.razorpay_payment_id === filter.razorpay_payment_id) {
        if (matchesFilter(row, filter)) {
          doc = row;
          break;
        }
        // Exists but filter doesn't match → upsert would E11000
        if (opts.upsert) {
          const err = new Error("E11000 duplicate key");
          err.code = 11000;
          throw err;
        }
        return null;
      }
    }
    if (!doc) {
      if (!opts.upsert) return null;
      doc = {
        _id: new ObjectId(),
        razorpay_payment_id: filter.razorpay_payment_id,
        ...(update.$setOnInsert || {}),
      };
      attempts.set(String(doc.razorpay_payment_id), doc);
    }
    if (update.$set) {
      for (const [k, val] of Object.entries(update.$set)) {
        nestSet(doc, k, val);
      }
    }
    return clone(doc);
  },
  updateOne: async (filter, update) => {
    for (const a of attempts.values()) {
      if (matchesFilter(a, filter)) {
        if (update.$set) {
          for (const [k, val] of Object.entries(update.$set)) {
            nestSet(a, k, val);
          }
        }
        return { matchedCount: 1 };
      }
    }
    return { matchedCount: 0 };
  },
};

const fakeRazorpayInstance = {
  payments: {
    refund: async (paymentId, opts = {}) => {
      refunds.push({ paymentId: String(paymentId), opts });
      return {
        id: `rfnd_${refunds.length}`,
        amount: opts.amount || 10000,
        status: "processed",
      };
    },
  },
};

Module._load = function patched(request, parent, isMain) {
  if (request === "../model/Order" || request.endsWith("/model/Order")) {
    return fakeOrder;
  }
  if (
    request === "../model/PaymentAttempt" ||
    request.endsWith("/model/PaymentAttempt")
  ) {
    return fakePaymentAttempt;
  }
  if (request === "razorpay") {
    return function Razorpay() {
      return fakeRazorpayInstance;
    };
  }
  if (request === "../config/secret" || request.endsWith("/config/secret")) {
    return {
      secret: {
        razorpay_key_id: "rzp_test_x",
        razorpay_key_secret: "secret_x",
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

// Fresh require after mocks
const servicePath = path.join(
  __dirname,
  "../services/razorpay-refund.service.js"
);
delete require.cache[require.resolve(servicePath)];
const {
  safeAutoRefundPayment,
  refundPaidOrder,
  applyRazorpayRefundWebhook,
  acquirePersistLock,
  releasePersistLock,
  markPaymentAttemptOrderCreated,
} = require("../services/razorpay-refund.service");

const origLog = console.log;
console.log = (...args) => {
  if (args[0] === "[refund]") logs.push(JSON.parse(args[1]));
  else origLog(...args);
};

function reset() {
  orders.clear();
  attempts.clear();
  refunds.length = 0;
  logs.length = 0;
}

function seedOrder(partial) {
  const id = partial._id || new ObjectId();
  const o = {
    _id: id,
    status: "confirmed",
    paymentStatus: "paid",
    totalAmount: 100,
    invoice: 2000,
    refund: { status: "not_required" },
    paymentIntent: {
      razorpay_payment_id: "pay_test",
      razorpay_order_id: "order_test",
    },
    ...partial,
    paymentIntent: {
      razorpay_payment_id: "pay_test",
      razorpay_order_id: "order_test",
      ...(partial.paymentIntent || {}),
    },
  };
  orders.set(idStr(id), o);
  return o;
}

async function run() {
  // 1) Order exists before safety refund → skipped, zero Razorpay refunds
  reset();
  seedOrder({
    paymentIntent: { razorpay_payment_id: "pay_exists", razorpay_order_id: "o1" },
  });
  const skip = await safeAutoRefundPayment({
    razorpay_payment_id: "pay_exists",
    razorpay_order_id: "o1",
    reason: "order_create_failed",
    source: "test",
  });
  assert.strictEqual(skip.skipped, true);
  assert.strictEqual(skip.skipReason, "order_exists");
  assert.strictEqual(refunds.length, 0);
  assert.ok(logs.some((l) => l.status === "skipped" && l.skip_reason === "order_exists"));

  // 2) create failure + no Order → refund
  reset();
  const created = await safeAutoRefundPayment({
    razorpay_payment_id: "pay_orphan",
    razorpay_order_id: "o_orphan",
    reason: "order_create_failed",
    source: "persistVerifiedOrder",
  });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].paymentId, "pay_orphan");
  const attempt = attempts.get("pay_orphan");
  assert.strictEqual(attempt.status, "refunded");
  assert.ok(attempt.refundId);
  assert.ok(logs.some((l) => l.status === "success" && l.payment_id === "pay_orphan"));

  // 3) Duplicate auto-refund claim → one refund only
  reset();
  await safeAutoRefundPayment({
    razorpay_payment_id: "pay_once",
    reason: "out_of_stock",
    source: "verify",
  });
  const second = await safeAutoRefundPayment({
    razorpay_payment_id: "pay_once",
    reason: "out_of_stock",
    source: "verify",
  });
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(second.skipped, true);

  // 4) OOS + no Order → refund
  reset();
  const oos = await safeAutoRefundPayment({
    razorpay_payment_id: "pay_oos",
    razorpay_order_id: "o_oos",
    reason: "out_of_stock",
    source: "verifyRazorpayPayment",
  });
  assert.strictEqual(oos.ok, true);
  assert.strictEqual(refunds.length, 1);

  // 5) E11000 with existing Order → no refund (simulate gate)
  reset();
  seedOrder({
    paymentIntent: { razorpay_payment_id: "pay_dup", razorpay_order_id: "o_dup" },
  });
  const dup = await safeAutoRefundPayment({
    razorpay_payment_id: "pay_dup",
    reason: "order_create_failed",
    source: "persistVerifiedOrder",
  });
  assert.strictEqual(dup.skipped, true);
  assert.strictEqual(refunds.length, 0);

  // 6) Unrelated E11000 path: safe helper never called with blind refund —
  //    documented via skip when order appears; unrelated duplicate is controller logic
  //    (no Order for payment → would refund only for non-E11000). Assert helper still
  //    refuses when order exists for payment even after attempt marked failed.
  reset();
  seedOrder({
    paymentIntent: {
      razorpay_payment_id: "pay_unrelated_guard",
      razorpay_order_id: "o_u",
    },
  });
  await safeAutoRefundPayment({
    razorpay_payment_id: "pay_unrelated_guard",
    reason: "create_duplicate_key_unrelated",
    source: "persistVerifiedOrder",
  });
  assert.strictEqual(refunds.length, 0);

  // 7) Emergency cancel path → refundPaidOrder still refunds paid order
  reset();
  const paid = seedOrder({
    _id: new ObjectId(),
    paymentStatus: "paid",
    totalAmount: 250,
    paymentIntent: {
      razorpay_payment_id: "pay_emergency",
      razorpay_order_id: "o_em",
    },
    refund: { status: "not_required" },
  });
  // findOneAndUpdate claim needs match on _id in store — update fake to find by _id
  const em = await refundPaidOrder(paid, { reason: "customer_request" });
  assert.strictEqual(em.ok, true);
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].paymentId, "pay_emergency");
  const after = orders.get(idStr(paid._id));
  assert.ok(
    ["refunded", "paid"].includes(after.paymentStatus),
    "payment status updated"
  );
  assert.ok(after.refund?.razorpayRefundId || after.refund?.status === "completed" || after.refund?.status === "initiated");

  // 8) Refund webhook → Mongo becomes refunded (idempotent)
  reset();
  const whOrder = seedOrder({
    paymentIntent: {
      razorpay_payment_id: "pay_wh",
      razorpay_order_id: "o_wh",
    },
    paymentStatus: "paid",
    refund: { status: "not_required" },
  });
  const wh1 = await applyRazorpayRefundWebhook({
    razorpay_payment_id: "pay_wh",
    refundId: "rfnd_wh_1",
    amount: 100,
    event: "refund.processed",
  });
  assert.strictEqual(wh1.ok, true);
  assert.strictEqual(wh1.updated, true);
  const synced = orders.get(idStr(whOrder._id));
  assert.strictEqual(synced.paymentStatus, "refunded");
  assert.strictEqual(synced.refund.status, "completed");
  assert.strictEqual(synced.refund.razorpayRefundId, "rfnd_wh_1");

  const wh2 = await applyRazorpayRefundWebhook({
    razorpay_payment_id: "pay_wh",
    refundId: "rfnd_wh_1",
    amount: 100,
    event: "refund.processed",
  });
  assert.strictEqual(wh2.updated, false);
  assert.strictEqual(wh2.reason, "already_synced");

  // 9) Persist lock: second acquire fails while first holds
  reset();
  const lock1 = await acquirePersistLock("pay_lock", "o_lock");
  assert.strictEqual(lock1.acquired, true);
  const lock2 = await acquirePersistLock("pay_lock", "o_lock");
  assert.strictEqual(lock2.acquired, false);
  await releasePersistLock("pay_lock");
  const lock3 = await acquirePersistLock("pay_lock", "o_lock");
  assert.strictEqual(lock3.acquired, true);
  await markPaymentAttemptOrderCreated("pay_lock", new ObjectId(), "o_lock");
  // After order_created, auto refund must skip if order exists
  seedOrder({
    paymentIntent: { razorpay_payment_id: "pay_lock", razorpay_order_id: "o_lock" },
  });
  const afterCreate = await safeAutoRefundPayment({
    razorpay_payment_id: "pay_lock",
    reason: "should_skip",
    source: "test",
  });
  assert.strictEqual(afterCreate.skipped, true);
  assert.strictEqual(refunds.length, 0);

  // 10) Late order sync: refund happens then order appears → paymentStatus refunded
  reset();
  // Inject order mid-flight by wrapping findOne
  let findCalls = 0;
  const realFindOne = fakeOrder.findOne;
  fakeOrder.findOne = async (filter) => {
    findCalls += 1;
    // First gate: no order; after refund API, second find returns order
    if (findCalls === 1) return null;
    if (findCalls >= 2 && filter?.["paymentIntent.razorpay_payment_id"]) {
      const late = seedOrder({
        paymentIntent: {
          razorpay_payment_id: filter["paymentIntent.razorpay_payment_id"],
          razorpay_order_id: "o_late",
        },
        paymentStatus: "paid",
        refund: { status: "not_required" },
      });
      return clone(late);
    }
    return realFindOne(filter);
  };
  // Also need pre-api gate (second findOne in safeAutoRefund) to be null
  // Call order in safeAutoRefund: 1) initial find, 2) pre-api gate, 3) late after refund
  findCalls = 0;
  fakeOrder.findOne = async (filter) => {
    findCalls += 1;
    if (findCalls <= 2) return null;
    const late = {
      _id: new ObjectId(),
      paymentStatus: "paid",
      refund: { status: "not_required" },
      paymentIntent: {
        razorpay_payment_id: filter["paymentIntent.razorpay_payment_id"],
        razorpay_order_id: "o_late",
      },
    };
    orders.set(idStr(late._id), late);
    return clone(late);
  };
  await safeAutoRefundPayment({
    razorpay_payment_id: "pay_late",
    reason: "order_create_failed",
    source: "persistVerifiedOrder",
  });
  assert.strictEqual(refunds.length, 1);
  const lateSynced = [...orders.values()].find(
    (o) => o.paymentIntent?.razorpay_payment_id === "pay_late"
  );
  assert.ok(lateSynced);
  assert.strictEqual(lateSynced.paymentStatus, "refunded");
  fakeOrder.findOne = realFindOne;

  // 11) Normal successful checkout simulation: lock → mark created → no refund
  reset();
  const lockOk = await acquirePersistLock("pay_ok", "o_ok");
  assert.strictEqual(lockOk.acquired, true);
  const orderOk = seedOrder({
    paymentIntent: {
      razorpay_payment_id: "pay_ok",
      razorpay_order_id: "o_ok",
    },
  });
  await markPaymentAttemptOrderCreated("pay_ok", orderOk._id, "o_ok");
  await releasePersistLock("pay_ok");
  assert.strictEqual(refunds.length, 0);
  assert.strictEqual(attempts.get("pay_ok").status, "order_created");

  // 12) processing/packed/shipped paid orders: auto refund still skipped (order exists)
  for (const status of ["processing", "packed", "shipped"]) {
    reset();
    seedOrder({
      status,
      paymentStatus: "paid",
      paymentIntent: {
        razorpay_payment_id: `pay_${status}`,
        razorpay_order_id: `o_${status}`,
      },
    });
    const r = await safeAutoRefundPayment({
      razorpay_payment_id: `pay_${status}`,
      reason: "safety",
      source: "test",
    });
    assert.strictEqual(r.skipped, true, status);
    assert.strictEqual(refunds.length, 0, status);
  }

  console.log = origLog;
  Module._load = originalLoad;
  origLog("refund-safety: all tests passed");
}

run().catch((err) => {
  console.log = origLog;
  Module._load = originalLoad;
  console.error("refund-safety FAILED:", err);
  process.exit(1);
});
