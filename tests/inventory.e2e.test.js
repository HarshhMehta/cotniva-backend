#!/usr/bin/env node
/**
 * End-to-end inventory tests (in-memory fakes of Products + StockHold).
 * Run: node tests/inventory.e2e.test.js
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const Products = require("../model/Products");
const StockHold = require("../model/StockHold");

const products = new Map();
const holds = new Map();

const clone = (v) => JSON.parse(JSON.stringify(v));
const idStr = (id) => String(id);

function matchElem(doc, em) {
  const list = doc.sizeInventory || [];
  const re = em.size ? new RegExp(em.size.$regex, em.size.$options || "") : null;
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (re && !re.test(row.size)) continue;
    if (em.quantity?.$gte != null && Number(row.quantity) < em.quantity.$gte) {
      continue;
    }
    return i;
  }
  return -1;
}

function matches(doc, filter) {
  if (filter._id && idStr(doc._id) !== idStr(filter._id)) return false;
  if (filter.status?.$ne && doc.status === filter.status.$ne) return false;
  if (filter.sizeInventory?.$elemMatch) {
    const idx = matchElem(doc, filter.sizeInventory.$elemMatch);
    if (idx < 0) return false;
    doc.__matchIndex = idx;
  }
  if (filter.$or) {
    const empty = !doc.sizeInventory || doc.sizeInventory.length === 0;
    if (!empty) return false;
  }
  if (filter.quantity?.$gte != null && Number(doc.quantity) < filter.quantity.$gte) {
    return false;
  }
  if (filter.sellCount?.$gt != null && !(Number(doc.sellCount) > filter.sellCount.$gt)) {
    return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  if (Array.isArray(update)) {
    const set = update[0]?.$set || {};
    if (set.sellCount?.$max) {
      const sub = set.sellCount.$max[1]?.$subtract;
      const qty = Number(sub?.[1]) || 0;
      doc.sellCount = Math.max(0, (Number(doc.sellCount) || 0) - qty);
    }
    return;
  }
  if (update.$inc) {
    for (const [key, val] of Object.entries(update.$inc)) {
      if (key === "sizeInventory.$.quantity") {
        const idx = doc.__matchIndex;
        if (idx >= 0 && doc.sizeInventory[idx]) {
          doc.sizeInventory[idx].quantity += val;
        }
      } else {
        doc[key] = (Number(doc[key]) || 0) + val;
      }
    }
  }
  if (update.$set) {
    for (const [key, val] of Object.entries(update.$set)) {
      if (key.includes(".")) {
        const [a, b] = key.split(".");
        doc[a] = doc[a] || {};
        doc[a][b] = val;
      } else {
        doc[key] = val;
      }
    }
  }
}

function queryWrap(doc) {
  return {
    select() {
      return this;
    },
    lean() {
      return Promise.resolve(doc ? clone(doc) : null);
    },
    then(resolve, reject) {
      return Promise.resolve(doc ? clone(doc) : null).then(resolve, reject);
    },
  };
}

Products.findById = (id) => queryWrap(products.get(idStr(id)) || null);
Products.findOne = (filter) => {
  const doc = [...products.values()].find((d) => matches(clone(d), filter));
  return queryWrap(doc || null);
};
Products.updateOne = async (filter, update) => {
  const doc = [...products.values()].find((d) => matches(clone(d), filter));
  if (!doc) return { matchedCount: 0, modifiedCount: 0 };
  const working = clone(doc);
  if (!matches(working, filter)) return { matchedCount: 0, modifiedCount: 0 };
  applyUpdate(working, update);
  delete working.__matchIndex;
  products.set(idStr(working._id), working);
  return { matchedCount: 1, modifiedCount: 1 };
};
Products.create = async (data) => {
  const doc = {
    _id: data._id || new ObjectId(),
    sellCount: 0,
    status: data.status || "in-stock",
    ...data,
  };
  products.set(idStr(doc._id), clone(doc));
  return clone(doc);
};

function holdMatches(doc, filter) {
  if (filter.razorpayOrderId && doc.razorpayOrderId !== filter.razorpayOrderId) {
    return false;
  }
  if (filter.status && doc.status !== filter.status) return false;
  if (filter._id && idStr(doc._id) !== idStr(filter._id)) return false;
  if (filter.expiresAt) {
    if (filter.expiresAt.$ne === null && doc.expiresAt == null) return false;
    if (filter.expiresAt.$lte && !(doc.expiresAt && doc.expiresAt <= filter.expiresAt.$lte)) {
      return false;
    }
  }
  return true;
}

StockHold.create = async (data) => {
  const doc = {
    _id: new ObjectId(),
    sellCountApplied: false,
    ...data,
  };
  holds.set(doc.razorpayOrderId, clone(doc));
  return clone(doc);
};
StockHold.findOne = async (filter) => {
  const doc = [...holds.values()].find((d) => holdMatches(d, filter));
  return doc ? clone(doc) : null;
};
StockHold.find = (filter) => ({
  select() {
    return this;
  },
  then(resolve, reject) {
    const list = [...holds.values()]
      .filter((d) => holdMatches(d, filter))
      .map(clone);
    return Promise.resolve(list).then(resolve, reject);
  },
});
StockHold.findOneAndUpdate = async (filter, update, opts = {}) => {
  const doc = [...holds.values()].find((d) => holdMatches(d, filter));
  if (!doc) return null;
  applyUpdate(doc, update);
  holds.set(doc.razorpayOrderId, clone(doc));
  return opts.new ? clone(doc) : clone(doc);
};
StockHold.updateOne = async (filter, update) => {
  const doc = [...holds.values()].find((d) => holdMatches(d, filter));
  if (!doc) return { matchedCount: 0 };
  applyUpdate(doc, update);
  holds.set(doc.razorpayOrderId, clone(doc));
  return { matchedCount: 1 };
};

const inventory = require("../services/inventory.service");
const productService = require("../services/product.service");

ProductFindOnePatched();

function ProductFindOnePatched() {
  const Product = require("../model/Products");
  const origFindOne = Product.findOne;
  Product.findOne = (filter) => {
    if (filter?.slug) {
      return queryWrap(null);
    }
    return origFindOne(filter);
  };
}

function seedSized({ s = 1, m = 1, sellCount = 0, status = "in-stock" } = {}) {
  const id = new ObjectId();
  const doc = {
    _id: id,
    title: "Tee",
    sizes: ["S", "M"],
    sizeInventory: [
      { size: "S", quantity: s },
      { size: "M", quantity: m },
    ],
    quantity: s + m,
    sellCount,
    status,
  };
  products.set(idStr(id), doc);
  return id;
}

function seedLegacy({ qty = 2, sellCount = 0 } = {}) {
  const id = new ObjectId();
  const doc = {
    _id: id,
    title: "Legacy Tee",
    sizes: ["S", "M"],
    sizeInventory: [],
    quantity: qty,
    sellCount,
    status: qty > 0 ? "in-stock" : "out-of-stock",
  };
  products.set(idStr(id), doc);
  return id;
}

function getP(id) {
  return products.get(idStr(id));
}

async function run(name, fn) {
  products.clear();
  holds.clear();
  await fn();
  console.log(`ok  ${name}`);
}

(async () => {
  await run("S=1/M=1 ordering decrements the selected size only", async () => {
    const id = seedSized({ s: 1, m: 1 });
    const reserved = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    const p = getP(id);
    assert.equal(p.sizeInventory[0].quantity, 0);
    assert.equal(p.sizeInventory[1].quantity, 1);
    assert.equal(p.quantity, 1);
    assert.equal(p.sellCount, 0);
    assert.equal(p.status, "in-stock");
    assert.equal(reserved[0].mode, "size");
    await inventory.commitHold("rzp_s1");
  });

  await run("sellCount increases only on commitHold, not reserve", async () => {
    const id = seedSized({ s: 1, m: 1 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "M", orderQuantity: 1, title: "Tee" },
    ]);
    assert.equal(getP(id).sellCount, 0);
    await inventory.saveHold("rzp_pay", lines);
    await inventory.commitHold("rzp_pay");
    assert.equal(getP(id).sellCount, 1);
    assert.equal(getP(id).sizeInventory[1].quantity, 0);
    assert.equal(getP(id).quantity, 1);
    assert.equal(getP(id).status, "in-stock");
  });

  await run("simultaneous last-stock: only one reservation wins", async () => {
    const id = seedSized({ s: 1, m: 0 });
    const cart = [{ _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" }];
    const results = await Promise.allSettled([
      inventory.reserveCartStock(cart),
      inventory.reserveCartStock(cart),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(getP(id).sizeInventory[0].quantity, 0);
    assert.equal(getP(id).quantity, 0);
  });

  await run("admin sizeInventory persist + size removal", async () => {
    const id = seedSized({ s: 5, m: 5, sellCount: 9 });
    await productService.updateProductService(id, {
      title: "Tee",
      sku: "t",
      unit: "pcs",
      imageURLs: [],
      tags: [],
      parent: "cat",
      children: "",
      price: 10,
      discount: 0,
      productType: "general",
      description: "d",
      additionalInformation: [],
      brand: { name: "", id: null },
      category: { name: "c", id: new ObjectId() },
      sizes: ["M"],
      sizeInventory: [
        { size: "S", quantity: 99 },
        { size: "M", quantity: 3 },
      ],
      status: "in-stock",
    });
    const p = getP(id);
    assert.equal(p.sizeInventory.length, 1);
    assert.equal(p.sizeInventory[0].size, "M");
    assert.equal(p.sizeInventory[0].quantity, 3);
    assert.equal(p.quantity, 3);
    assert.equal(p.sellCount, 9);
  });

  await run("catalog-only edit does not overwrite live stock/sellCount", async () => {
    const id = seedSized({ s: 1, m: 1, sellCount: 4 });
    getP(id).sizeInventory[0].quantity = 0;
    getP(id).quantity = 1;
    getP(id).sellCount = 12;
    await productService.updateProductService(id, {
      title: "New Title",
      sku: "t",
      unit: "pcs",
      imageURLs: [],
      tags: [],
      parent: "cat",
      children: "",
      price: 99,
      discount: 0,
      productType: "general",
      description: "d",
      additionalInformation: [],
      brand: { name: "", id: null },
      category: { name: "c", id: new ObjectId() },
      status: "in-stock",
    });
    const p = getP(id);
    assert.equal(p.title, "New Title");
    assert.equal(p.price, 99);
    assert.equal(p.sizeInventory[0].quantity, 0);
    assert.equal(p.quantity, 1);
    assert.equal(p.sellCount, 12);
  });

  await run("payment failure/cancel restores exact size", async () => {
    const id = seedSized({ s: 1, m: 1 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    const hold = await inventory.saveHold("rzp_fail", lines);
    const released = await inventory.releaseHold("rzp_fail", {
      releaseToken: hold.releaseToken,
    });
    assert.equal(released.status, "released");
    assert.equal(getP(id).sizeInventory[0].quantity, 1);
    assert.equal(getP(id).quantity, 2);
    assert.equal(getP(id).sellCount, 0);
    const again = await inventory.releaseHold("rzp_fail", {
      releaseToken: hold.releaseToken,
    });
    assert.equal(again.status, "released");
    assert.equal(getP(id).sizeInventory[0].quantity, 1);
  });

  await run("release-stock without token is forbidden", async () => {
    const id = seedSized({ s: 1, m: 1 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    await inventory.saveHold("rzp_tok", lines);
    const forbidden = await inventory.releaseHold("rzp_tok", { releaseToken: "nope" });
    assert.equal(forbidden.status, "forbidden");
    assert.equal(getP(id).sizeInventory[0].quantity, 0);
  });

  await run("hold expiry restores stock", async () => {
    const id = seedSized({ s: 1, m: 1 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "M", orderQuantity: 1, title: "Tee" },
    ]);
    await inventory.saveHold("rzp_exp", lines);
    const hold = holds.get("rzp_exp");
    hold.expiresAt = new Date(Date.now() - 1000);
    holds.set("rzp_exp", hold);
    const n = await inventory.expireHeldStocks(new Date());
    assert.equal(n, 1);
    assert.equal(getP(id).sizeInventory[1].quantity, 1);
    assert.equal(holds.get("rzp_exp").status, "released");
  });

  await run("admin cancel restores size + sellCount once (idempotent)", async () => {
    const id = seedSized({ s: 1, m: 1 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    await inventory.saveHold("rzp_cxl", lines);
    await inventory.commitHold("rzp_cxl");
    assert.equal(getP(id).sellCount, 1);
    const first = await inventory.restoreCommittedHold("rzp_cxl", [
      { _id: id, selectedSize: "S", orderQuantity: 1 },
    ]);
    assert.equal(first, true);
    assert.equal(getP(id).sizeInventory[0].quantity, 1);
    assert.equal(getP(id).sellCount, 0);
    const second = await inventory.restoreCommittedHold("rzp_cxl", [
      { _id: id, selectedSize: "S", orderQuantity: 1 },
    ]);
    assert.equal(second, false);
    assert.equal(getP(id).sizeInventory[0].quantity, 1);
    assert.equal(getP(id).sellCount, 0);
  });

  await run("duplicate commitHold does not double sellCount", async () => {
    const id = seedSized({ s: 2, m: 0 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    await inventory.saveHold("rzp_dup", lines);
    await inventory.commitHold("rzp_dup");
    await inventory.commitHold("rzp_dup");
    assert.equal(getP(id).sellCount, 1);
  });

  await run("legacy product without sizeInventory uses shared quantity", async () => {
    const id = seedLegacy({ qty: 2 });
    const reserved = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Legacy Tee" },
    ]);
    assert.equal(reserved[0].mode, "legacy");
    assert.equal(getP(id).quantity, 1);
    assert.equal((getP(id).sizeInventory || []).length, 0);
    await inventory.saveHold("rzp_leg", reserved);
    await inventory.commitHold("rzp_leg");
    const restored = await inventory.restoreCommittedHold("rzp_leg", [
      { _id: id, selectedSize: "S", orderQuantity: 1 },
    ]);
    assert.equal(restored, true);
    assert.equal(getP(id).quantity, 2);
  });

  await run("S vs s cart lines merge before reserve", async () => {
    const id = seedSized({ s: 2, m: 0 });
    const lines = inventory.normalizeCartLines([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
      { _id: id, selectedSize: "s", orderQuantity: 1, title: "Tee" },
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].qty, 2);
    await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
      { _id: id, selectedSize: "s", orderQuantity: 1, title: "Tee" },
    ]);
    assert.equal(getP(id).sizeInventory[0].quantity, 0);
  });

  await run("multi-item reserve rolls back first line if second fails", async () => {
    const a = seedSized({ s: 1, m: 0 });
    const b = seedSized({ s: 0, m: 0 });
    await assert.rejects(() =>
      inventory.reserveCartStock([
        { _id: a, selectedSize: "S", orderQuantity: 1, title: "A" },
        { _id: b, selectedSize: "S", orderQuantity: 1, title: "B" },
      ])
    );
    assert.equal(getP(a).sizeInventory[0].quantity, 1);
    assert.equal(getP(b).sizeInventory[0].quantity, 0);
  });

  await run("sellCount revert never goes negative", async () => {
    const id = seedSized({ s: 1, m: 0, sellCount: 0 });
    await inventory.revertSoldCounts([
      { productId: String(id), qty: 5, mode: "size", selectedSize: "S" },
    ]);
    assert.equal(getP(id).sellCount, 0);
  });

  await run("legacy cart without selectedSize on sized product does not steal stock", async () => {
    const id = seedSized({ s: 1, m: 1 });
    await assert.rejects(() =>
      inventory.reserveCartStock([
        { _id: id, selectedSize: "", orderQuantity: 1, title: "Tee" },
      ])
    );
    assert.equal(getP(id).quantity, 2);
    assert.equal(getP(id).sizeInventory[0].quantity, 1);
  });

  await run("status sync: last unit sold -> out-of-stock, restore -> in-stock", async () => {
    const id = seedSized({ s: 1, m: 0 });
    const lines = await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    assert.equal(getP(id).status, "out-of-stock");
    await inventory.restoreReservations(lines);
    assert.equal(getP(id).status, "in-stock");
  });

  await run("discontinued status is preserved", async () => {
    const id = seedSized({ s: 2, m: 0, status: "discontinued" });
    await inventory.reserveCartStock([
      { _id: id, selectedSize: "S", orderQuantity: 1, title: "Tee" },
    ]);
    assert.equal(getP(id).status, "discontinued");
  });

  console.log("\nAll inventory e2e tests passed.");
})().catch((err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
