#!/usr/bin/env node
/**
 * Product review / rating safety tests (in-memory fakes; no DB / Cloudinary).
 * Run: node tests/review-safety.test.js
 */
const assert = require("assert");
const Module = require("module");
const path = require("path");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const originalLoad = Module._load;
const reviews = new Map();
const orders = new Map();
const products = new Map();
const users = new Map();
const mails = [];
let uploadCalls = 0;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const idStr = (v) => (v == null ? "" : String(v));

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
    let cur = doc;
    for (const p of String(k).split(".")) {
      if (cur == null) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(v, "$in")) {
        if (!v.$in.map(idStr).includes(idStr(cur))) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(v, "$exists")) {
        const exists = cur !== undefined && cur !== null;
        if (Boolean(v.$exists) !== exists) return false;
        continue;
      }
      continue;
    }
    if (idStr(cur) !== idStr(v)) return false;
  }
  return true;
}

function makeChain(list) {
  const state = { skipN: 0, limitN: null };
  const api = {
    sort() {
      return api;
    },
    skip(n) {
      state.skipN = n;
      return api;
    },
    limit(n) {
      state.limitN = n;
      return api;
    },
    populate() {
      return api;
    },
    lean() {
      return Promise.resolve(
        list.slice(
          state.skipN,
          state.limitN == null ? undefined : state.skipN + state.limitN
        )
      );
    },
    then(resolve, reject) {
      return Promise.resolve(
        list.slice(
          state.skipN,
          state.limitN == null ? undefined : state.skipN + state.limitN
        )
      ).then(resolve, reject);
    },
  };
  return api;
}

const FakeReview = {
  async create(doc) {
    for (const r of reviews.values()) {
      if (
        idStr(r.userId) === idStr(doc.userId) &&
        idStr(r.order) === idStr(doc.order) &&
        idStr(r.productId) === idStr(doc.productId)
      ) {
        const err = new Error("E11000 duplicate");
        err.code = 11000;
        throw err;
      }
    }
    const _id = new ObjectId();
    const row = {
      ...clone(doc),
      _id,
      images: Array.isArray(doc.images) ? [...doc.images] : [],
      createdAt: new Date(),
      updatedAt: new Date(),
      toObject() {
        return { ...this };
      },
    };
    reviews.set(idStr(_id), row);
    return row;
  },
  findOne(filter) {
    const hit = [...reviews.values()].find((d) => matchesFilter(d, filter));
    return {
      lean: async () => (hit ? clone(hit) : null),
      then: (resolve, reject) => Promise.resolve(hit || null).then(resolve, reject),
    };
  },
  find(filter) {
    const list = [...reviews.values()]
      .filter((d) => matchesFilter(d, filter))
      .map((d) => clone(d));
    return makeChain(list);
  },
  findById(id) {
    const hit = reviews.get(idStr(id));
    if (!hit) {
      return {
        populate() {
          return this;
        },
        then: (r, j) => Promise.resolve(null).then(r, j),
      };
    }
    const doc = {
      ...hit,
      save: async function save() {
        reviews.set(idStr(this._id), { ...this });
        return this;
      },
      populate() {
        return this;
      },
      toObject() {
        return { ...this };
      },
    };
    return {
      populate() {
        return this;
      },
      then: (r, j) => Promise.resolve(doc).then(r, j),
    };
  },
  findByIdAndUpdate(id, update, opts) {
    const hit = reviews.get(idStr(id));
    if (!hit) {
      return {
        populate() {
          return this;
        },
        then: (r, j) => Promise.resolve(null).then(r, j),
      };
    }
    if (update?.$set) Object.assign(hit, update.$set);
    const out = { ...hit };
    return {
      populate() {
        return this;
      },
      then: (r, j) => Promise.resolve(opts?.new === false ? hit : out).then(r, j),
    };
  },
  findByIdAndDelete(id) {
    const hit = reviews.get(idStr(id));
    if (hit) reviews.delete(idStr(id));
    return Promise.resolve(hit || null);
  },
  countDocuments(filter) {
    return Promise.resolve(
      [...reviews.values()].filter((d) => matchesFilter(d, filter)).length
    );
  },
  aggregate(pipeline) {
    const match = pipeline.find((s) => s.$match)?.$match || {};
    const group = pipeline.find((s) => s.$group)?.$group;
    const matched = [...reviews.values()].filter((d) => matchesFilter(d, match));
    if (!group) return Promise.resolve(matched);
    if (group.avgRating != null || group.avg != null) {
      const avg =
        matched.length === 0
          ? 0
          : matched.reduce((s, d) => s + Number(d.rating || 0), 0) /
            matched.length;
      return Promise.resolve([
        {
          _id: null,
          avgRating: avg,
          avg,
          count: matched.length,
          total: matched.length,
          r1: matched.filter((d) => d.rating === 1).length,
          r2: matched.filter((d) => d.rating === 2).length,
          r3: matched.filter((d) => d.rating === 3).length,
          r4: matched.filter((d) => d.rating === 4).length,
          r5: matched.filter((d) => d.rating === 5).length,
        },
      ]);
    }
    if (group._id === "$status") {
      const map = {};
      for (const d of matched) map[d.status] = (map[d.status] || 0) + 1;
      return Promise.resolve(
        Object.entries(map).map(([_id, count]) => ({ _id, count }))
      );
    }
    if (group._id === "$rating") {
      const map = {};
      for (const d of matched) map[d.rating] = (map[d.rating] || 0) + 1;
      return Promise.resolve(
        Object.entries(map).map(([_id, count]) => ({ _id: Number(_id), count }))
      );
    }
    return Promise.resolve([]);
  },
  deleteMany(filter) {
    let n = 0;
    for (const [k, d] of [...reviews.entries()]) {
      if (matchesFilter(d, filter)) {
        reviews.delete(k);
        n += 1;
      }
    }
    return Promise.resolve({ deletedCount: n });
  },
};

const FakeOrder = {
  findById(id) {
    const hit = orders.get(idStr(id)) || null;
    return {
      lean: async () => (hit ? clone(hit) : null),
      then: (r, j) => Promise.resolve(hit).then(r, j),
    };
  },
  find(filter) {
    const list = [...orders.values()].filter((d) => matchesFilter(d, filter));
    return {
      select() {
        return this;
      },
      limit() {
        return this;
      },
      lean: async () => list.map(clone),
    };
  },
  findOneAndUpdate() {
    return Promise.resolve(null);
  },
  updateOne() {
    return Promise.resolve({ acknowledged: true });
  },
};

const FakeProducts = {
  findById(id) {
    const hit = products.get(idStr(id));
    return {
      select() {
        return Promise.resolve(hit || null);
      },
      then: (r, j) => Promise.resolve(hit || null).then(r, j),
    };
  },
  find() {
    return {
      select() {
        return this;
      },
      limit() {
        return this;
      },
      lean: async () => [...products.values()].map(clone),
    };
  },
  updateOne() {
    return Promise.resolve({ acknowledged: true });
  },
};

const FakeUser = {
  find() {
    return {
      select() {
        return this;
      },
      limit() {
        return this;
      },
      lean: async () => [...users.values()].map(clone),
    };
  },
  updateOne() {
    return Promise.resolve({ acknowledged: true });
  },
};

Module._load = function load(request, parent, isMain) {
  const resolved = (() => {
    try {
      return Module._resolveFilename(request, parent);
    } catch {
      return request;
    }
  })();
  if (resolved.endsWith(`${path.sep}model${path.sep}Review.js`)) return FakeReview;
  if (resolved.endsWith(`${path.sep}model${path.sep}Order.js`)) return FakeOrder;
  if (resolved.endsWith(`${path.sep}model${path.sep}Products.js`)) return FakeProducts;
  if (resolved.endsWith(`${path.sep}model${path.sep}User.js`)) return FakeUser;
  if (resolved.endsWith(`${path.sep}config${path.sep}email.js`)) {
    return {
      sendMailAsync: async (mail) => {
        mails.push(mail);
        return { messageId: "test-msg" };
      },
    };
  }
  if (resolved.endsWith(`${path.sep}config${path.sep}secret.js`)) {
    return {
      secret: {
        client_url: "https://shop.test",
        admin_url: "https://admin.test",
        admin_order_email: "",
        email_user: "",
        cloudinary_upload_preset: "test",
      },
    };
  }
  if (resolved.endsWith(`${path.sep}services${path.sep}cloudinary.service.js`)) {
    return {
      cloudinaryServices: {
        cloudinaryImageUpload: async () => {
          uploadCalls += 1;
          return {
            secure_url: `https://res.cloudinary.com/demo/image/upload/r${uploadCalls}.jpg`,
            public_id: `r${uploadCalls}`,
          };
        },
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const ctrl = require("../controller/review.controller");
const imgUtil = require("../utils/review-images");
const emailSvc = require("../services/order-email.service");

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function call(handler, req) {
  const res = mockRes();
  let nextErr = null;
  await handler(req, res, (err) => {
    nextErr = err;
  });
  if (nextErr) throw nextErr;
  return res;
}

const jpegBuf = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const pngBuf = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const gifBuf = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
]);

const userA = new ObjectId();
const userB = new ObjectId();
const productA = new ObjectId();
const productB = new ObjectId();
const orderDelivered = new ObjectId();
const orderProcessing = new ObjectId();
const orderOtherUser = new ObjectId();

function seed() {
  reviews.clear();
  orders.clear();
  products.clear();
  users.clear();
  mails.length = 0;
  uploadCalls = 0;

  products.set(idStr(productA), {
    _id: productA,
    title: "White Tie Up Kurti",
    img: "https://img/a.jpg",
  });
  products.set(idStr(productB), {
    _id: productB,
    title: "Other Product",
    img: "https://img/b.jpg",
  });

  orders.set(idStr(orderDelivered), {
    _id: orderDelivered,
    user: userA,
    status: "delivered",
    invoice: 1017,
    email: "buyer@example.com",
    name: "Buyer",
    cart: [{ _id: productA, title: "White Tie Up Kurti", price: 999 }],
    totalAmount: 999,
  });
  orders.set(idStr(orderProcessing), {
    _id: orderProcessing,
    user: userA,
    status: "processing",
    invoice: 1018,
    email: "buyer@example.com",
    cart: [{ _id: productA, title: "White Tie Up Kurti", price: 999 }],
  });
  orders.set(idStr(orderOtherUser), {
    _id: orderOtherUser,
    user: userB,
    status: "delivered",
    invoice: 1020,
    email: "other@example.com",
    cart: [{ _id: productA, title: "White Tie Up Kurti", price: 999 }],
  });
}

async function run() {
  let passed = 0;
  const ok = (name) => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log("\nReview safety tests\n");

  // magic bytes
  assert.strictEqual(imgUtil.detectImageMimeFromBuffer(jpegBuf), "image/jpeg");
  assert.strictEqual(imgUtil.detectImageMimeFromBuffer(pngBuf), "image/png");
  assert.strictEqual(imgUtil.detectImageMimeFromBuffer(gifBuf), "image/gif");
  ok("Image magic-byte detection works");

  // 6. Rating only
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [],
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.review.rating, 5);
    assert.deepStrictEqual(res.body.review.images, []);
    assert.strictEqual(res.body.review.status, undefined);
    assert.ok(!("status" in res.body.review));
    assert.ok(String(res.body.message).toLowerCase().includes("thank you"));
    ok("Review can be submitted with rating only");
    ok("Customer API does not expose moderation status");
  }

  // 1. Without images
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: {
        orderId: orderDelivered,
        productId: productA,
        rating: 4,
        comment: "Nice",
      },
      files: [],
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body.review.images, []);
    ok("Customer can submit review without images");
  }

  // 2. With 1 image
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [{ buffer: jpegBuf, mimetype: "image/jpeg", originalname: "a.jpg" }],
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.review.images.length, 1);
    assert.ok(res.body.review.images[0].includes("cloudinary.com"));
    ok("Customer can submit review with 1 image");
  }

  // 3. With 3 images
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [
        { buffer: jpegBuf, mimetype: "image/jpeg" },
        { buffer: pngBuf, mimetype: "image/png" },
        { buffer: jpegBuf, mimetype: "image/jpeg" },
      ],
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.review.images.length, 3);
    ok("Customer can submit review with up to 3 images");
  }

  // 4. 4th image rejected
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [
        { buffer: jpegBuf },
        { buffer: jpegBuf },
        { buffer: jpegBuf },
        { buffer: jpegBuf },
      ],
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, "TOO_MANY_IMAGES");
    ok("4th image is rejected");
  }

  // 5. Invalid file type
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [{ buffer: gifBuf, mimetype: "image/gif" }],
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, "INVALID_IMAGE_TYPE");
    ok("Invalid file type is rejected");
  }

  // 7. Undelivered
  seed();
  {
    const res = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderProcessing, productId: productA, rating: 4 },
      files: [],
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, "NOT_DELIVERED");
    ok("Review cannot be submitted for undelivered order");
  }

  // 8. Duplicate
  seed();
  {
    await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [],
    });
    const second = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 4 },
      files: [],
    });
    assert.strictEqual(second.statusCode, 409);
    assert.strictEqual(second.body.code, "DUPLICATE_REVIEW");
    assert.ok(!("status" in (second.body.review || {})));
    ok("Duplicate review is rejected");
  }

  // 9–10. Cannot edit / change status
  seed();
  {
    const created = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 4 },
      files: [],
    });
    const reviewId = created.body.review._id;
    const patched = await call(ctrl.updateMyReview, {
      user: { _id: userA },
      params: { id: reviewId },
      body: { status: "approved", rating: 5 },
    });
    assert.strictEqual(patched.statusCode, 405);
    assert.strictEqual(patched.body.code, "EDIT_NOT_ALLOWED");
    ok("Customer cannot edit an existing review");
    ok("Customer cannot change review status");
  }

  // 11. Order state strips status
  seed();
  {
    await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [],
    });
    const state = await call(ctrl.getOrderReviewState, {
      user: { _id: userA },
      params: { orderId: orderDelivered },
    });
    assert.strictEqual(state.statusCode, 200);
    const rev = state.body.items[0].review;
    assert.ok(rev);
    assert.ok(!("status" in rev));
    ok("Customer order review state hides moderation status");
  }

  // 12. Admin approve/reject
  seed();
  {
    const created = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [],
    });
    const reviewId = created.body.review._id;
    const approved = await call(ctrl.adminUpdateStatus, {
      params: { id: reviewId },
      body: { status: "approved" },
    });
    assert.strictEqual(approved.body.review.status, "approved");
    const rejected = await call(ctrl.adminUpdateStatus, {
      params: { id: reviewId },
      body: { status: "rejected" },
    });
    assert.strictEqual(rejected.body.review.status, "rejected");
    ok("Admin can still approve/reject");
  }

  // 13–14. Public approved only + images
  seed();
  {
    const created = await call(ctrl.createReview, {
      user: { _id: userA },
      body: { orderId: orderDelivered, productId: productA, rating: 5 },
      files: [{ buffer: jpegBuf }],
    });
    const reviewId = created.body.review._id;
    await call(ctrl.adminUpdateStatus, {
      params: { id: reviewId },
      body: { status: "approved" },
    });
    reviews.set(idStr(new ObjectId()), {
      _id: new ObjectId(),
      userId: userB,
      order: orderOtherUser,
      productId: productA,
      rating: 1,
      status: "pending",
      images: ["https://res.cloudinary.com/demo/image/upload/hidden.jpg"],
      isVerifiedPurchase: true,
    });

    const pub = await call(ctrl.getProductReviews, {
      params: { productId: productA },
      query: {},
    });
    assert.strictEqual(pub.statusCode, 200);
    assert.ok(pub.body.data.every((r) => r.status === "approved"));
    assert.ok(pub.body.data.some((r) => (r.images || []).length > 0));
    ok("Public API returns only approved reviews");
    ok("Approved review images are returned");
  }

  // Delivered email CTA (no moderation mention)
  seed();
  {
    await emailSvc.sendOrderDeliveredEmail(orders.get(idStr(orderDelivered)));
    const html = mails[0].html || "";
    assert.ok(html.includes("Write a Review"));
    assert.ok(!/pending|approved|rejected|moderat/i.test(html));
    ok("Delivered email review CTA has no moderation copy");
  }

  console.log(`\n${passed} assertions passed\n`);
}

run().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
