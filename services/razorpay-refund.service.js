/**
 * Idempotent Razorpay refunds:
 * - refundPaidOrder: explicit admin emergency cancel (may refund paid orders)
 * - safeAutoRefundPayment: safety path — NEVER refunds if an Order already exists
 * - persist locks via PaymentAttempt
 */
const Razorpay = require("razorpay");
const { secret } = require("../config/secret");
const Order = require("../model/Order");
const PaymentAttempt = require("../model/PaymentAttempt");

const PERSIST_LOCK_MS = Math.max(
  30 * 1000,
  Number(process.env.PAYMENT_PERSIST_LOCK_MS) || 2 * 60 * 1000
);

const getRazorpay = () => {
  if (!secret.razorpay_key_id || !secret.razorpay_key_secret) {
    throw new Error("Razorpay keys are not configured");
  }
  return new Razorpay({
    key_id: secret.razorpay_key_id,
    key_secret: secret.razorpay_key_secret,
  });
};

const alreadyRefunded = (order) => {
  const st = String(order?.refund?.status || "").toLowerCase();
  return (
    Boolean(order?.refund?.razorpayRefundId) ||
    st === "initiated" ||
    st === "completed" ||
    String(order?.paymentStatus || "").toLowerCase() === "refunded"
  );
};

const findOrderByPaymentId = async (razorpay_payment_id) => {
  if (!razorpay_payment_id) return null;
  return Order.findOne({
    "paymentIntent.razorpay_payment_id": String(razorpay_payment_id),
  });
};

const logRefundEvent = (payload) => {
  console.log(
    "[refund]",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...payload,
    })
  );
};

/**
 * Acquire per-payment persist lock. Stale locks (past persistLockUntil) can be reclaimed.
 */
const acquirePersistLock = async (razorpay_payment_id, razorpay_order_id) => {
  if (!razorpay_payment_id) {
    return { acquired: false, reason: "missing_payment_id" };
  }

  const existingOrder = await findOrderByPaymentId(razorpay_payment_id);
  if (existingOrder) {
    return {
      acquired: false,
      reason: "order_exists",
      order: existingOrder,
    };
  }

  const now = new Date();
  const lockUntil = new Date(now.getTime() + PERSIST_LOCK_MS);

  try {
    const attempt = await PaymentAttempt.findOneAndUpdate(
      {
        razorpay_payment_id: String(razorpay_payment_id),
        status: { $nin: ["refunded", "refund_pending", "order_created"] },
        $or: [
          { persistLockUntil: { $exists: false } },
          { persistLockUntil: null },
          { persistLockUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "persisting",
          persistLockUntil: lockUntil,
          razorpay_order_id: razorpay_order_id || "",
          lastSource: "persist_lock",
          lastError: "",
        },
        $setOnInsert: {
          razorpay_payment_id: String(razorpay_payment_id),
        },
      },
      { upsert: true, new: true }
    );
    if (!attempt) {
      return { acquired: false, reason: "locked" };
    }
    return { acquired: true, attempt };
  } catch (err) {
    if (err?.code === 11000) {
      return { acquired: false, reason: "locked" };
    }
    throw err;
  }
};

/**
 * Release persist lock if still in persisting state (crash-safe cleanup).
 */
const releasePersistLock = async (razorpay_payment_id) => {
  if (!razorpay_payment_id) return;
  await PaymentAttempt.updateOne(
    {
      razorpay_payment_id: String(razorpay_payment_id),
      status: "persisting",
    },
    {
      $set: {
        status: "idle",
        persistLockUntil: null,
      },
    }
  );
};

const markPaymentAttemptOrderCreated = async (
  razorpay_payment_id,
  orderId,
  razorpay_order_id
) => {
  if (!razorpay_payment_id) return;
  await PaymentAttempt.findOneAndUpdate(
    { razorpay_payment_id: String(razorpay_payment_id) },
    {
      $set: {
        status: "order_created",
        orderId: orderId || null,
        razorpay_order_id: razorpay_order_id || "",
        persistLockUntil: null,
        lastError: "",
      },
      $setOnInsert: {
        razorpay_payment_id: String(razorpay_payment_id),
      },
    },
    { upsert: true }
  );
};

const syncOrderToRefunded = async (
  order,
  { refundId, amount, reason, source, completed = true } = {}
) => {
  if (!order?._id) return;
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        paymentStatus: "refunded",
        "refund.status": completed ? "completed" : "initiated",
        "refund.razorpayRefundId":
          refundId || order.refund?.razorpayRefundId || "",
        ...(amount != null ? { "refund.amount": amount } : {}),
        "refund.initiatedAt": order.refund?.initiatedAt || new Date(),
        ...(completed ? { "refund.completedAt": new Date() } : {}),
        "refund.error": "",
        "refund.lastAttemptAt": new Date(),
        "refund.source": source || "auto",
        "refund.reason": reason || "",
      },
    }
  );
};

/**
 * Automatic/safety refund — NEVER refunds if an Order already exists for this payment.
 */
const safeAutoRefundPayment = async ({
  razorpay_payment_id,
  razorpay_order_id,
  reason,
  source,
  orderId = null,
} = {}) => {
  const baseLog = {
    payment_id: razorpay_payment_id || null,
    razorpay_order_id: razorpay_order_id || null,
    reason: reason || "unspecified",
    source: source || "unknown",
    order_id: orderId ? String(orderId) : null,
  };

  if (!razorpay_payment_id) {
    logRefundEvent({
      ...baseLog,
      status: "failed",
      error: "missing_payment_id",
      refund_id: null,
    });
    return { ok: false, status: "failed", error: "missing_payment_id" };
  }

  const existing = await findOrderByPaymentId(razorpay_payment_id);
  if (existing) {
    logRefundEvent({
      ...baseLog,
      order_id: String(existing._id),
      status: "skipped",
      skip_reason: "order_exists",
      refund_id: null,
    });
    return {
      ok: true,
      status: "skipped",
      skipped: true,
      skipReason: "order_exists",
      order: existing,
    };
  }

  const now = new Date();
  let attempt;
  try {
    attempt = await PaymentAttempt.findOneAndUpdate(
      {
        razorpay_payment_id: String(razorpay_payment_id),
        status: { $nin: ["refunded", "refund_pending"] },
        $or: [
          { persistLockUntil: { $exists: false } },
          { persistLockUntil: null },
          { persistLockUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "refund_pending",
          persistLockUntil: new Date(now.getTime() + PERSIST_LOCK_MS),
          razorpay_order_id: razorpay_order_id || "",
          lastReason: reason || "",
          lastSource: source || "",
          lastError: "",
        },
        $setOnInsert: {
          razorpay_payment_id: String(razorpay_payment_id),
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err?.code === 11000) {
      const current = await PaymentAttempt.findOne({
        razorpay_payment_id: String(razorpay_payment_id),
      });
      if (current?.status === "refunded") {
        logRefundEvent({
          ...baseLog,
          status: "skipped",
          skip_reason: "already_refunded_attempt",
          refund_id: current.refundId || null,
        });
        return {
          ok: true,
          status: "skipped",
          skipped: true,
          skipReason: "already_refunded",
          refundId: current.refundId,
        };
      }
      logRefundEvent({
        ...baseLog,
        status: "skipped",
        skip_reason: "refund_in_progress",
        refund_id: null,
      });
      return {
        ok: true,
        status: "skipped",
        skipped: true,
        skipReason: "refund_in_progress",
      };
    }
    throw err;
  }

  if (!attempt) {
    const current = await PaymentAttempt.findOne({
      razorpay_payment_id: String(razorpay_payment_id),
    });
    if (current?.status === "refunded") {
      logRefundEvent({
        ...baseLog,
        status: "skipped",
        skip_reason: "already_refunded_attempt",
        refund_id: current.refundId || null,
      });
      return {
        ok: true,
        status: "skipped",
        skipped: true,
        refundId: current.refundId,
      };
    }
    logRefundEvent({
      ...baseLog,
      status: "skipped",
      skip_reason: "could_not_claim",
      refund_id: null,
    });
    return {
      ok: true,
      status: "skipped",
      skipped: true,
      skipReason: "could_not_claim",
    };
  }

  // Final gate immediately before Razorpay API
  const gate = await findOrderByPaymentId(razorpay_payment_id);
  if (gate) {
    await PaymentAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          status: "skipped",
          persistLockUntil: null,
          orderId: gate._id,
          lastReason: reason || "",
          lastSource: source || "",
        },
      }
    );
    logRefundEvent({
      ...baseLog,
      order_id: String(gate._id),
      status: "skipped",
      skip_reason: "order_exists_pre_api",
      refund_id: null,
    });
    return {
      ok: true,
      status: "skipped",
      skipped: true,
      skipReason: "order_exists",
      order: gate,
    };
  }

  try {
    const razorpay = getRazorpay();
    const refund = await razorpay.payments.refund(String(razorpay_payment_id), {
      notes: {
        reason: String(reason || "safety_refund").slice(0, 200),
        source: String(source || "auto").slice(0, 100),
        razorpay_order_id: String(razorpay_order_id || ""),
      },
    });

    const refundId = refund?.id || "";
    const refundAmount =
      refund?.amount != null ? Number(refund.amount) / 100 : undefined;
    const rzpStatus = String(refund?.status || "").toLowerCase();
    const completed = ["processed", "completed"].includes(rzpStatus);

    await PaymentAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          status: "refunded",
          refundId,
          persistLockUntil: null,
          lastReason: reason || "",
          lastSource: source || "",
          lastError: "",
        },
      }
    );

    const lateOrder = await findOrderByPaymentId(razorpay_payment_id);
    if (lateOrder) {
      await syncOrderToRefunded(lateOrder, {
        refundId,
        amount: refundAmount,
        reason,
        source,
        completed,
      });
    }

    logRefundEvent({
      ...baseLog,
      order_id: lateOrder ? String(lateOrder._id) : null,
      status: "success",
      refund_id: refundId || null,
      razorpay_refund_status: rzpStatus || null,
    });

    return {
      ok: true,
      status: completed ? "completed" : "initiated",
      refundId,
      amount: refundAmount,
    };
  } catch (err) {
    const message = err?.error?.description || err?.message || "Refund failed";
    const already = /already/i.test(message);

    if (already) {
      await PaymentAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: {
            status: "refunded",
            persistLockUntil: null,
            lastReason: reason || "",
            lastSource: source || "",
            lastError: message,
          },
        }
      );
      const lateOrder = await findOrderByPaymentId(razorpay_payment_id);
      if (lateOrder) {
        await syncOrderToRefunded(lateOrder, {
          reason,
          source,
          completed: true,
        });
      }
      logRefundEvent({
        ...baseLog,
        order_id: lateOrder ? String(lateOrder._id) : null,
        status: "success",
        skip_reason: "already_refunded_at_razorpay",
        refund_id: null,
        error: message,
      });
      return { ok: true, status: "completed", skipped: true, error: message };
    }

    await PaymentAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          status: "failed",
          persistLockUntil: null,
          lastError: message,
          lastReason: reason || "",
          lastSource: source || "",
        },
      }
    );
    logRefundEvent({
      ...baseLog,
      status: "failed",
      refund_id: null,
      error: message,
    });
    return { ok: false, status: "failed", error: message };
  }
};

/**
 * Sync Mongo when Razorpay reports a refund (webhook). Idempotent.
 */
const applyRazorpayRefundWebhook = async ({
  razorpay_payment_id,
  refundId,
  amount,
  event,
} = {}) => {
  if (!razorpay_payment_id) {
    return { ok: false, updated: false, reason: "missing_payment_id" };
  }

  const order = await findOrderByPaymentId(razorpay_payment_id);
  if (order) {
    if (alreadyRefunded(order) && order.paymentStatus === "refunded") {
      return { ok: true, updated: false, reason: "already_synced", order };
    }
    await syncOrderToRefunded(order, {
      refundId,
      amount,
      reason: `webhook:${event || "refund"}`,
      source: "razorpay_webhook",
      completed: true,
    });
  }

  await PaymentAttempt.findOneAndUpdate(
    { razorpay_payment_id: String(razorpay_payment_id) },
    {
      $set: {
        status: "refunded",
        refundId: refundId || "",
        persistLockUntil: null,
        lastSource: "razorpay_webhook",
        lastReason: event || "refund",
        ...(order ? { orderId: order._id } : {}),
      },
      $setOnInsert: {
        razorpay_payment_id: String(razorpay_payment_id),
      },
    },
    { upsert: true }
  );

  logRefundEvent({
    payment_id: razorpay_payment_id,
    razorpay_order_id: order?.paymentIntent?.razorpay_order_id || null,
    reason: `webhook:${event || "refund"}`,
    source: "razorpay_webhook",
    order_id: order ? String(order._id) : null,
    status: "success",
    refund_id: refundId || null,
  });

  return { ok: true, updated: Boolean(order), order };
};

/**
 * Explicit admin emergency-cancel refund (MAY refund a paid order).
 */
const refundPaidOrder = async (order, { reason } = {}) => {
  if (!order) {
    return { ok: false, status: "failed", error: "Order missing" };
  }

  if (alreadyRefunded(order)) {
    return {
      ok: true,
      status: order.refund?.status || "initiated",
      refundId: order.refund?.razorpayRefundId || "",
      amount: order.refund?.amount,
      skipped: true,
    };
  }

  const paymentId = order.paymentIntent?.razorpay_payment_id;
  if (!paymentId) {
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "refund.status": "failed",
          "refund.error": "No Razorpay payment id on order",
          "refund.failedAt": new Date(),
          "refund.lastAttemptAt": new Date(),
        },
      }
    );
    return {
      ok: false,
      status: "failed",
      error: "No Razorpay payment id on order",
    };
  }

  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: "paid",
      $or: [
        { "refund.status": { $in: ["not_required", "pending", "failed"] } },
        { "refund.status": { $exists: false } },
        { refund: { $exists: false } },
      ],
      $and: [
        {
          $or: [
            { "refund.razorpayRefundId": { $exists: false } },
            { "refund.razorpayRefundId": null },
            { "refund.razorpayRefundId": "" },
          ],
        },
      ],
    },
    {
      $set: {
        "refund.status": "pending",
        "refund.lastAttemptAt": new Date(),
        "refund.error": "",
        "refund.source": "emergency_cancel",
      },
    },
    { new: true }
  );

  if (!claimed) {
    const fresh = await Order.findById(order._id);
    if (alreadyRefunded(fresh)) {
      return {
        ok: true,
        status: fresh.refund?.status || "initiated",
        refundId: fresh.refund?.razorpayRefundId || "",
        amount: fresh.refund?.amount,
        skipped: true,
      };
    }
    return {
      ok: false,
      status: "failed",
      error: "Could not claim refund lock — order may not be paid",
    };
  }

  const amountPaise = Math.round(Number(claimed.totalAmount || 0) * 100);
  try {
    const razorpay = getRazorpay();
    const refund = await razorpay.payments.refund(paymentId, {
      amount: amountPaise > 0 ? amountPaise : undefined,
      notes: {
        orderId: String(claimed._id),
        invoice: String(claimed.invoice || ""),
        reason: String(reason || "emergency_cancel").slice(0, 200),
      },
    });

    const refundId = refund?.id || "";
    const refundAmount =
      refund?.amount != null ? Number(refund.amount) / 100 : claimed.totalAmount;
    const rzpStatus = String(refund?.status || "").toLowerCase();
    const completed = ["processed", "completed"].includes(rzpStatus);

    await Order.updateOne(
      { _id: claimed._id },
      {
        $set: {
          paymentStatus: completed ? "refunded" : "paid",
          "refund.status": completed ? "completed" : "initiated",
          "refund.razorpayRefundId": refundId,
          "refund.amount": refundAmount,
          "refund.initiatedAt": new Date(),
          ...(completed ? { "refund.completedAt": new Date() } : {}),
          "refund.error": "",
          "refund.lastAttemptAt": new Date(),
          "refund.source": "emergency_cancel",
          "refund.reason": reason || "emergency_cancel",
        },
      }
    );

    logRefundEvent({
      payment_id: paymentId,
      razorpay_order_id: claimed.paymentIntent?.razorpay_order_id || null,
      reason: reason || "emergency_cancel",
      source: "emergency_cancel",
      order_id: String(claimed._id),
      status: "success",
      refund_id: refundId || null,
    });

    return {
      ok: true,
      status: completed ? "completed" : "initiated",
      refundId,
      amount: refundAmount,
    };
  } catch (err) {
    const message = err?.error?.description || err?.message || "Refund failed";
    await Order.updateOne(
      { _id: claimed._id },
      {
        $set: {
          "refund.status": "failed",
          "refund.error": message,
          "refund.failedAt": new Date(),
          "refund.lastAttemptAt": new Date(),
        },
      }
    );
    logRefundEvent({
      payment_id: paymentId,
      razorpay_order_id: claimed.paymentIntent?.razorpay_order_id || null,
      reason: reason || "emergency_cancel",
      source: "emergency_cancel",
      order_id: String(claimed._id),
      status: "failed",
      refund_id: null,
      error: message,
    });
    return { ok: false, status: "failed", error: message };
  }
};

module.exports = {
  getRazorpay,
  refundPaidOrder,
  alreadyRefunded,
  safeAutoRefundPayment,
  acquirePersistLock,
  releasePersistLock,
  markPaymentAttemptOrderCreated,
  applyRazorpayRefundWebhook,
  findOrderByPaymentId,
  PERSIST_LOCK_MS,
};
