const crypto = require("crypto");
const mongoose = require("mongoose");
const Products = require("../model/Products");
const StockHold = require("../model/StockHold");

const HOLD_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.STOCK_HOLD_TTL_MS) || 20 * 60 * 1000
);
const EXPIRY_SWEEP_MS = Math.max(
  5000,
  Number(process.env.STOCK_HOLD_SWEEP_MS) || 60 * 1000
);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSizeKey = (size) => String(size || "").trim().toUpperCase();

const toObjectId = (id) => {
  if (!id) return null;
  const raw = String(id);
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  try {
    return new mongoose.Types.ObjectId(raw);
  } catch {
    return null;
  }
};

const sizeMatch = (size) => ({
  $regex: `^${escapeRegex(String(size).trim())}$`,
  $options: "i",
});

const emptySizeInventory = {
  $or: [
    { sizeInventory: { $exists: false } },
    { sizeInventory: { $size: 0 } },
  ],
};

const hasSizeInventory = (product) =>
  Array.isArray(product?.sizeInventory) && product.sizeInventory.length > 0;

const normalizeSizeInventory = (list = [], allowedSizes) => {
  const allow =
    Array.isArray(allowedSizes) && allowedSizes.length > 0
      ? new Set(allowedSizes.map((s) => normalizeSizeKey(s)).filter(Boolean))
      : null;
  const seen = new Set();
  const rows = [];
  for (const row of list || []) {
    const size = String(row?.size || "").trim();
    if (!size) continue;
    const key = normalizeSizeKey(size);
    if (seen.has(key)) continue;
    if (allow && !allow.has(key)) continue;
    seen.add(key);
    rows.push({
      size,
      quantity: Math.max(0, Math.floor(Number(row.quantity) || 0)),
    });
  }
  return rows;
};

const stockStatusFromQty = (quantity, currentStatus) => {
  if (currentStatus === "discontinued") return "discontinued";
  return Number(quantity) > 0 ? "in-stock" : "out-of-stock";
};

const syncProductStockStatus = async (productId) => {
  const id = toObjectId(productId);
  if (!id) return;
  const product = await Products.findById(id).select("quantity status").lean();
  if (!product || product.status === "discontinued") return;
  const next = stockStatusFromQty(product.quantity, product.status);
  if (product.status !== next) {
    await Products.updateOne(
      { _id: id, status: { $ne: "discontinued" } },
      { $set: { status: next } }
    );
  }
};

/**
 * Merge cart rows so the same product+size is one atomic decrement.
 */
const normalizeCartLines = (cart = []) => {
  const map = new Map();
  for (const item of cart || []) {
    const productId = item?._id || item?.id || item?.productId;
    const selectedSize = String(item?.selectedSize || "").trim();
    const qty = Math.max(0, Number(item?.orderQuantity) || 0);
    if (!productId || qty < 1) {
      const err = new Error("Invalid cart line for stock update");
      err.statusCode = 400;
      throw err;
    }
    const key = `${productId}::${normalizeSizeKey(selectedSize)}`;
    const prev = map.get(key);
    if (prev) {
      prev.qty += qty;
    } else {
      map.set(key, {
        productId: String(productId),
        selectedSize,
        qty,
        title: item?.title || "Product",
      });
    }
  }
  return [...map.values()];
};

const decrementLine = async (line) => {
  const id = toObjectId(line.productId);
  const qty = Number(line.qty);
  if (!id || !Number.isFinite(qty) || qty < 1) {
    return { ok: false, reason: "invalid_product", line };
  }

  const size = String(line.selectedSize || "").trim();
  if (size) {
    const sized = await Products.updateOne(
      {
        _id: id,
        sizeInventory: {
          $elemMatch: {
            size: sizeMatch(size),
            quantity: { $gte: qty },
          },
        },
      },
      {
        $inc: {
          "sizeInventory.$.quantity": -qty,
          quantity: -qty,
        },
      }
    );
    if (sized.matchedCount === 1) {
      await syncProductStockStatus(id);
      return {
        ok: true,
        reservation: {
          productId: String(id),
          selectedSize: size,
          qty,
          mode: "size",
        },
      };
    }
  }

  const legacy = await Products.updateOne(
    {
      _id: id,
      ...emptySizeInventory,
      quantity: { $gte: qty },
    },
    {
      $inc: {
        quantity: -qty,
      },
    }
  );
  if (legacy.matchedCount === 1) {
    await syncProductStockStatus(id);
    return {
      ok: true,
      reservation: {
        productId: String(id),
        selectedSize: "",
        qty,
        mode: "legacy",
      },
    };
  }

  return { ok: false, reason: "out_of_stock", line };
};

const restoreLine = async (reservation) => {
  const id = toObjectId(reservation.productId);
  const qty = Number(reservation.qty);
  if (!id || !Number.isFinite(qty) || qty < 1) return false;

  if (reservation.mode === "size") {
    const size = String(reservation.selectedSize || "").trim();
    const res = await Products.updateOne(
      {
        _id: id,
        sizeInventory: {
          $elemMatch: { size: sizeMatch(size) },
        },
      },
      {
        $inc: {
          "sizeInventory.$.quantity": qty,
          quantity: qty,
        },
      }
    );
    if (res.matchedCount === 1) {
      await syncProductStockStatus(id);
      return true;
    }
    return false;
  }

  const res = await Products.updateOne(
    { _id: id, ...emptySizeInventory },
    {
      $inc: {
        quantity: qty,
      },
    }
  );
  if (res.matchedCount === 1) {
    await syncProductStockStatus(id);
    return true;
  }
  return false;
};

const restoreReservations = async (reservations = []) => {
  let allOk = true;
  for (const row of reservations) {
    try {
      const ok = await restoreLine(row);
      if (!ok) allOk = false;
    } catch (e) {
      allOk = false;
      console.log("inventory restore failed:", e.message);
    }
  }
  return allOk;
};

const qtyByProduct = (reservations = []) => {
  const byProduct = new Map();
  for (const row of reservations || []) {
    const id = String(row.productId || "");
    const qty = Number(row.qty);
    if (!id || !Number.isFinite(qty) || qty < 1) continue;
    byProduct.set(id, (byProduct.get(id) || 0) + qty);
  }
  return byProduct;
};

/** Payment success only — not during reservation. */
const applySoldCounts = async (reservations = []) => {
  for (const [productId, qty] of qtyByProduct(reservations)) {
    const id = toObjectId(productId);
    if (!id) continue;
    await Products.updateOne({ _id: id }, { $inc: { sellCount: qty } });
  }
};

const revertSoldCounts = async (reservations = []) => {
  for (const [productId, qty] of qtyByProduct(reservations)) {
    const id = toObjectId(productId);
    if (!id) continue;
    await Products.updateOne({ _id: id }, [
      {
        $set: {
          sellCount: {
            $max: [0, { $subtract: [{ $ifNull: ["$sellCount", 0] }, qty] }],
          },
        },
      },
    ]);
  }
};

const stockErrorMessage = (failed) => {
  const size = failed?.line?.selectedSize;
  const title = failed?.line?.title || "This item";
  if (size) {
    return `${title} (size ${size}) does not have enough stock.`;
  }
  return `${title} does not have enough stock.`;
};

const linesFromCart = async (cart = []) => {
  const normalized = normalizeCartLines(cart);
  const lines = [];
  for (const line of normalized) {
    const id = toObjectId(line.productId);
    const product = id
      ? await Products.findById(id).select("sizeInventory").lean()
      : null;
    const size = String(line.selectedSize || "").trim();
    if (hasSizeInventory(product) && size) {
      lines.push({
        productId: line.productId,
        selectedSize: size,
        qty: line.qty,
        mode: "size",
      });
    } else if (!hasSizeInventory(product)) {
      lines.push({
        productId: line.productId,
        selectedSize: "",
        qty: line.qty,
        mode: "legacy",
      });
    }
  }
  return lines;
};

/**
 * Atomically reserve stock for every cart line.
 * Rolls back any successful lines if a later line fails or throws.
 */
const reserveCartStock = async (cart) => {
  const lines = normalizeCartLines(cart);
  if (!lines.length) {
    const err = new Error("Cart is empty");
    err.statusCode = 400;
    throw err;
  }

  const reserved = [];
  try {
    for (const line of lines) {
      const result = await decrementLine(line);
      if (!result.ok) {
        await restoreReservations(reserved);
        const err = new Error(stockErrorMessage(result));
        err.statusCode = 409;
        err.code = "OUT_OF_STOCK";
        throw err;
      }
      reserved.push(result.reservation);
    }
    return reserved;
  } catch (err) {
    if (reserved.length && err.code !== "OUT_OF_STOCK") {
      await restoreReservations(reserved);
    }
    throw err;
  }
};

const newReleaseToken = () => crypto.randomBytes(24).toString("hex");

const saveHold = async (razorpayOrderId, lines, extras = {}) => {
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS);
  return StockHold.create({
    razorpayOrderId: String(razorpayOrderId),
    lines,
    status: "held",
    sellCountApplied: false,
    expiresAt,
    releaseToken: extras.releaseToken || newReleaseToken(),
    orderDraft: extras.orderDraft || null,
  });
};

const getHold = async (razorpayOrderId) => {
  if (!razorpayOrderId) return null;
  return StockHold.findOne({ razorpayOrderId: String(razorpayOrderId) });
};

const commitHold = async (razorpayOrderId) => {
  if (!razorpayOrderId) return { status: "missing" };
  const held = await StockHold.findOneAndUpdate(
    { razorpayOrderId: String(razorpayOrderId), status: "held" },
    { $set: { status: "committed", expiresAt: null } },
    { new: true }
  );
  if (held) {
    if (!held.sellCountApplied) {
      await applySoldCounts(held.lines || []);
      held.sellCountApplied = true;
      await StockHold.updateOne(
        { _id: held._id },
        { $set: { sellCountApplied: true } }
      );
    }
    return { status: "committed", hold: held };
  }

  const existing = await StockHold.findOne({
    razorpayOrderId: String(razorpayOrderId),
  });
  if (!existing) return { status: "missing" };
  return { status: existing.status, hold: existing };
};

const releaseHold = async (razorpayOrderId, opts = {}) => {
  if (!razorpayOrderId) return { status: "missing" };
  const existing = await StockHold.findOne({
    razorpayOrderId: String(razorpayOrderId),
  });
  if (!existing) return { status: "missing" };

  if (!opts.internal) {
    const token = String(opts.releaseToken || "");
    if (!token || token !== existing.releaseToken) {
      return { status: "forbidden", hold: existing };
    }
  }

  if (existing.status === "released") {
    return { status: "released", hold: existing };
  }
  if (existing.status === "committed") {
    return { status: "committed", hold: existing };
  }

  const held = await StockHold.findOneAndUpdate(
    { razorpayOrderId: String(razorpayOrderId), status: "held" },
    { $set: { status: "released", expiresAt: null } },
    { new: true }
  );
  if (held) {
    await restoreReservations(held.lines || []);
    return { status: "released", hold: held };
  }
  const again = await StockHold.findOne({
    razorpayOrderId: String(razorpayOrderId),
  });
  return { status: again?.status || "missing", hold: again };
};

const expireHeldStocks = async (now = new Date()) => {
  const due = await StockHold.find({
    status: "held",
    expiresAt: { $ne: null, $lte: now },
  }).select("razorpayOrderId");
  let released = 0;
  for (const row of due) {
    const result = await releaseHold(row.razorpayOrderId, { internal: true });
    if (result.status === "released") released += 1;
  }
  return released;
};

let expiryTimer = null;
const startHoldExpiryJob = () => {
  if (expiryTimer) return expiryTimer;
  const tick = () => {
    expireHeldStocks().catch((e) =>
      console.log("stock hold expiry:", e.message)
    );
  };
  tick();
  expiryTimer = setInterval(tick, EXPIRY_SWEEP_MS);
  if (typeof expiryTimer.unref === "function") expiryTimer.unref();
  return expiryTimer;
};

/**
 * Restore stock for a paid/committed order (admin cancel). Idempotent.
 * Also reverts sellCount only when those units were counted as sold.
 */
const restoreCommittedHold = async (razorpayOrderId, fallbackCart) => {
  if (razorpayOrderId) {
    const committed = await StockHold.findOneAndUpdate(
      { razorpayOrderId: String(razorpayOrderId), status: "committed" },
      { $set: { status: "released", expiresAt: null } },
      { new: true }
    );
    if (committed) {
      const stockOk = await restoreReservations(committed.lines || []);
      if (committed.sellCountApplied) {
        await revertSoldCounts(committed.lines || []);
        await StockHold.updateOne(
          { _id: committed._id },
          { $set: { sellCountApplied: false } }
        );
      }
      return stockOk;
    }

    const held = await StockHold.findOneAndUpdate(
      { razorpayOrderId: String(razorpayOrderId), status: "held" },
      { $set: { status: "released", expiresAt: null } },
      { new: true }
    );
    if (held) {
      return restoreReservations(held.lines || []);
    }

    const existing = await StockHold.findOne({
      razorpayOrderId: String(razorpayOrderId),
    });
    if (existing?.status === "released") return false;
  }

  if (Array.isArray(fallbackCart) && fallbackCart.length) {
    try {
      const lines = await linesFromCart(fallbackCart);
      if (!lines.length) return false;
      const stockOk = await restoreReservations(lines);
      return stockOk;
    } catch (e) {
      console.log("fallback inventory restore failed:", e.message);
    }
  }
  return false;
};

const attachCommittedHold = async (razorpayOrderId, lines, extras = {}) => {
  const existing = await getHold(razorpayOrderId);
  if (existing) {
    const wasApplied = !!existing.sellCountApplied;
    await StockHold.updateOne(
      { _id: existing._id },
      {
        $set: {
          lines,
          status: "committed",
          expiresAt: null,
        },
      }
    );
    if (!wasApplied) {
      await applySoldCounts(lines);
      await StockHold.updateOne(
        { _id: existing._id },
        { $set: { sellCountApplied: true } }
      );
    }
    return { status: "committed" };
  }
  await saveHold(razorpayOrderId, lines, extras);
  return commitHold(razorpayOrderId);
};

module.exports = {
  HOLD_TTL_MS,
  normalizeSizeKey,
  normalizeSizeInventory,
  stockStatusFromQty,
  normalizeCartLines,
  reserveCartStock,
  restoreReservations,
  saveHold,
  getHold,
  commitHold,
  releaseHold,
  restoreCommittedHold,
  applySoldCounts,
  revertSoldCounts,
  stockErrorMessage,
  expireHeldStocks,
  startHoldExpiryJob,
  newReleaseToken,
  linesFromCart,
  syncProductStockStatus,
  attachCommittedHold,
};
