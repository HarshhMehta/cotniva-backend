const Order = require("../model/Order");
const {
  restoreCommittedHold,
} = require("./inventory.service");
const { refundPaidOrder } = require("./razorpay-refund.service");
const {
  sendOrderConfirmedEmails,
  sendOrderShippedEmail,
  sendOrderOutForDeliveryEmail,
  sendOrderDeliveredEmail,
  sendOrderCancelledEmails,
  beginEmailSend,
  completeEmailSend,
  failEmailSend,
  claimEmailSlot,
} = require("./order-email.service");
const {
  sendOrderConfirmedWhatsApp,
  sendOrderShippedWhatsApp,
  sendOrderOutForDeliveryWhatsApp,
  sendOrderDeliveredWhatsApp,
  sendOrderCancelledWhatsApp,
} = require("./order-whatsapp.service");
const {
  notifyNewOrder,
  notifyOrderCancelled,
} = require("./notification.service");

const NORMAL_TRANSITIONS = {
  confirmed: ["processing"],
  pending: ["processing"], // legacy (= confirmed)
  processing: ["packed"],
  packed: ["shipped"],
  shipped: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
};

const EMERGENCY_CANCEL_FROM = new Set([
  "confirmed",
  "pending", // legacy
  "processing",
  "packed",
]);

const CANCEL_REASONS = [
  { code: "product_unavailable", label: "Product unavailable" },
  { code: "inventory_issue", label: "Inventory issue" },
  { code: "pricing_error", label: "Pricing error" },
  { code: "customer_address_issue", label: "Customer/address issue" },
  { code: "payment_verification_issue", label: "Payment/order verification issue" },
  { code: "other", label: "Other" },
];

const normalizeStatus = (s) => String(s || "").toLowerCase().trim();

const isCancelled = (s) => ["cancel", "cancelled"].includes(normalizeStatus(s));

const getAllowedNextStatuses = (current) => {
  const cur = normalizeStatus(current);
  return NORMAL_TRANSITIONS[cur] ? [...NORMAL_TRANSITIONS[cur]] : [];
};

const canEmergencyCancel = (current) =>
  EMERGENCY_CANCEL_FROM.has(normalizeStatus(current));

const appendHistory = (order, entry) => {
  if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
  order.statusHistory.push({
    from: entry.from ?? null,
    to: entry.to,
    at: entry.at || new Date(),
    source: entry.source || "system",
    adminId: entry.adminId || undefined,
    adminEmail: entry.adminEmail || undefined,
    reason: entry.reason || undefined,
    note: entry.note || undefined,
  });
};

/**
 * Send a lifecycle email at most once.
 * - Acquires a short-lived send lock (concurrent callers skip)
 * - Marks emailsSent only after sendFn succeeds
 * - Releases lock on failure so the email remains retryable
 */
const sendLifecycleEmailOnce = async (orderId, key, sendFn, { alsoMark = [] } = {}) => {
  const claimed = await beginEmailSend(orderId, key);
  if (!claimed) {
    console.log(`[order-email] ${key} skipped (already sent or locked) order=${orderId}`);
    return { sent: false, skipped: true };
  }
  try {
    console.log(`[order-email] ${key} sending… order=${orderId}`);
    await sendFn();
    await completeEmailSend(orderId, key);
    for (const extra of alsoMark) {
      await claimEmailSlot(orderId, extra);
    }
    console.log(`[order-email] ${key} sent OK order=${orderId}`);
    return { sent: true };
  } catch (err) {
    console.error(`lifecycle email ${key}:`, err.message);
    await failEmailSend(orderId, key);
    return { sent: false, error: err.message };
  }
};

/** Clear send locks so a failed/hung send can be retried */
const clearNotificationLocks = async (orderId, keys = []) => {
  if (!orderId || !keys.length) return;
  const unset = {};
  for (const key of keys) {
    unset[`emailsSending.${key}`] = 1;
    unset[`whatsappSending.${key}`] = 1;
  }
  await Order.updateOne({ _id: orderId }, { $unset: unset });
};

/**
 * After first successful Order.create for a paid Razorpay payment.
 * Email + WhatsApp run in parallel so a slow SMTP cannot block WhatsApp.
 */
const onOrderConfirmedCreated = async (order) => {
  if (!order) return { email: null, whatsapp: null };
  console.log(
    `[order-notify] confirmed start order=${order._id} email=${order.email} contact=${order.contact}`
  );

  const [emailResult, whatsappResult] = await Promise.all([
    sendLifecycleEmailOnce(
      order._id,
      "confirmed",
      async () => {
        await sendOrderConfirmedEmails(order);
      },
      { alsoMark: ["admin_new_order"] }
    ),
    sendOrderConfirmedWhatsApp(order),
  ]);

  console.log(
    `[order-notify] confirmed done order=${order._id}`,
    JSON.stringify({ email: emailResult, whatsapp: whatsappResult })
  );
  return { email: emailResult, whatsapp: whatsappResult };
};

/**
 * Force re-send confirmed customer+admin email and WhatsApp (admin / recovery).
 */
const resendOrderConfirmedNotifications = async (orderId, { force = true } = {}) => {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }

  if (force) {
    await Order.updateOne(
      { _id: order._id },
      {
        $unset: {
          "emailsSent.confirmed": 1,
          "emailsSent.admin_new_order": 1,
          "emailsSending.confirmed": 1,
          "emailsSending.admin_new_order": 1,
          "whatsappSent.confirmed": 1,
          "whatsappSending.confirmed": 1,
        },
      }
    );
  } else {
    await clearNotificationLocks(order._id, ["confirmed", "admin_new_order"]);
  }

  const fresh = await Order.findById(order._id);
  return onOrderConfirmedCreated(fresh);
};

/**
 * Apply a normal forward fulfillment transition (admin).
 */
const applyFulfillmentStatus = async ({
  orderId,
  nextStatus,
  admin,
  trackingNumber,
  trackingUrl,
}) => {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }

  const current = normalizeStatus(order.status);
  const next = normalizeStatus(nextStatus);

  if (next === "confirmed") {
    const err = new Error("Confirmed is set automatically after payment");
    err.statusCode = 400;
    throw err;
  }

  if (isCancelled(next) || next === "cancel") {
    const err = new Error(
      "Use emergency cancel endpoint for cancellations"
    );
    err.statusCode = 400;
    throw err;
  }

  if (current === next) {
    return { order, unchanged: true, allowedNext: getAllowedNextStatuses(current) };
  }

  const allowed = getAllowedNextStatuses(current);
  if (!allowed.includes(next)) {
    const err = new Error(
      `Invalid status transition: ${current} → ${next}. Allowed: ${allowed.join(", ") || "none"}`
    );
    err.statusCode = 400;
    throw err;
  }

  if (normalizeStatus(order.paymentStatus) !== "paid" && normalizeStatus(order.paymentStatus) !== "refunded") {
    const err = new Error("Cannot advance fulfillment unless payment is paid");
    err.statusCode = 400;
    throw err;
  }

  appendHistory(order, {
    from: current,
    to: next,
    source: "admin",
    adminId: admin?._id,
    adminEmail: admin?.email,
  });

  order.status = next;
  if (trackingNumber != null) order.trackingNumber = String(trackingNumber);
  if (trackingUrl != null) order.trackingUrl = String(trackingUrl);
  await order.save();

  if (next === "shipped") {
    await sendLifecycleEmailOnce(order._id, "shipped", () =>
      sendOrderShippedEmail(order)
    );
    await sendOrderShippedWhatsApp(order);
  } else if (next === "out_for_delivery") {
    await sendLifecycleEmailOnce(order._id, "out_for_delivery", () =>
      sendOrderOutForDeliveryEmail(order)
    );
    await sendOrderOutForDeliveryWhatsApp(order);
  } else if (next === "delivered") {
    await sendLifecycleEmailOnce(order._id, "delivered", () =>
      sendOrderDeliveredEmail(order)
    );
    await sendOrderDeliveredWhatsApp(order);
  }

  return {
    order,
    unchanged: false,
    allowedNext: getAllowedNextStatuses(next),
  };
};

/**
 * Emergency admin cancellation + idempotent refund + inventory restore.
 */
const emergencyCancelOrder = async ({
  orderId,
  reasonCode,
  reasonText,
  admin,
}) => {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }

  const current = normalizeStatus(order.status);

  // Idempotent: already cancelled
  if (isCancelled(current)) {
    return {
      order,
      alreadyCancelled: true,
      refund: {
        status: order.refund?.status,
        refundId: order.refund?.razorpayRefundId,
        error: order.refund?.error,
      },
    };
  }

  if (!canEmergencyCancel(current)) {
    const err = new Error(
      `Emergency cancel not allowed from status "${current}". Allowed from: confirmed, processing, packed.`
    );
    err.statusCode = 400;
    throw err;
  }

  const reason =
    CANCEL_REASONS.find((r) => r.code === reasonCode)?.label ||
    String(reasonText || "").trim();
  if (!reason) {
    const err = new Error("Cancellation reason is required");
    err.statusCode = 400;
    throw err;
  }

  const paymentStatus = normalizeStatus(order.paymentStatus);
  if (paymentStatus !== "paid" && paymentStatus !== "refunded") {
    const err = new Error("Emergency cancel requires a paid order");
    err.statusCode = 400;
    throw err;
  }

  // Transition to cancelled first (claim cancel)
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: { $in: [...EMERGENCY_CANCEL_FROM] },
    },
    {
      $set: {
        status: "cancelled",
        "cancellation.reason": reason,
        "cancellation.reasonCode": reasonCode || "other",
        "cancellation.cancelledAt": new Date(),
        "cancellation.cancelledBy": admin?._id,
        "cancellation.cancelledByEmail": admin?.email || "",
      },
      $push: {
        statusHistory: {
          from: current,
          to: "cancelled",
          at: new Date(),
          source: "admin",
          adminId: admin?._id,
          adminEmail: admin?.email,
          reason,
        },
      },
    },
    { new: true }
  );

  if (!claimed) {
    const fresh = await Order.findById(orderId);
    if (isCancelled(fresh?.status)) {
      return {
        order: fresh,
        alreadyCancelled: true,
        refund: {
          status: fresh.refund?.status,
          refundId: fresh.refund?.razorpayRefundId,
        },
      };
    }
    const err = new Error("Could not cancel order — status may have changed");
    err.statusCode = 409;
    throw err;
  }

  // Inventory restore (idempotent via inventoryRestored flag)
  let inventoryRestored = Boolean(claimed.paymentIntent?.inventoryRestored);
  if (
    claimed.paymentIntent?.inventoryReserved &&
    !claimed.paymentIntent?.inventoryRestored
  ) {
    const restored = await restoreCommittedHold(
      claimed.paymentIntent?.razorpay_order_id,
      claimed.cart
    );
    if (restored) {
      inventoryRestored = true;
      await Order.updateOne(
        { _id: claimed._id },
        {
          $set: {
            "paymentIntent.inventoryRestored": true,
          },
        }
      );
    }
  }

  // Refund
  let refundResult = { ok: true, status: "not_required", skipped: true };
  if (normalizeStatus(claimed.paymentStatus) === "paid") {
    refundResult = await refundPaidOrder(claimed, { reason });
  } else if (normalizeStatus(claimed.paymentStatus) === "refunded") {
    refundResult = {
      ok: true,
      status: claimed.refund?.status || "completed",
      refundId: claimed.refund?.razorpayRefundId,
      skipped: true,
    };
  }

  const fresh = await Order.findById(claimed._id);

  notifyOrderCancelled(fresh).catch((e) =>
    console.log("notify cancel:", e.message)
  );

  await sendLifecycleEmailOnce(
    fresh._id,
    "cancelled",
    () =>
      sendOrderCancelledEmails(fresh, {
        reason,
        refundStatus: refundResult.status,
        refundId: refundResult.refundId,
        refundError: refundResult.error,
      }),
    { alsoMark: ["admin_cancelled"] }
  );

  await sendOrderCancelledWhatsApp(fresh, {
    reason,
    refundStatus: refundResult.status,
  });

  return {
    order: fresh,
    alreadyCancelled: false,
    inventoryRestored,
    refund: refundResult,
  };
};

module.exports = {
  NORMAL_TRANSITIONS,
  EMERGENCY_CANCEL_FROM,
  CANCEL_REASONS,
  normalizeStatus,
  isCancelled,
  getAllowedNextStatuses,
  canEmergencyCancel,
  appendHistory,
  onOrderConfirmedCreated,
  applyFulfillmentStatus,
  emergencyCancelOrder,
  resendOrderConfirmedNotifications,
  clearNotificationLocks,
};
