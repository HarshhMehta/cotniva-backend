const Order = require("../model/Order");
const { secret } = require("../config/secret");
const {
  sendWhatsAppText,
  waitForWhatsAppConnected,
  normalizePhone,
} = require("./whatsapp.service");

const BRAND = "Cotniva";

const WA_SEND_LOCK_MS = Math.max(
  60 * 1000,
  Number(process.env.WHATSAPP_SEND_LOCK_MS) || 5 * 60 * 1000
);

const storeUrl = () => secret.client_url || "https://cotniva.vercel.app";

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

const invoiceLabel = (order) =>
  order?.invoice != null ? `#${order.invoice}` : "";

/**
 * Atomically begin a WhatsApp send (short-lived lock).
 * Same idempotency idea as lifecycle emails.
 */
const beginWhatsAppSend = async (orderId, key) => {
  if (!orderId || !key) return false;
  const sentField = `whatsappSent.${key}`;
  const lockField = `whatsappSending.${key}`;
  const staleBefore = new Date(Date.now() - WA_SEND_LOCK_MS);

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      $and: [
        {
          $or: [{ [sentField]: { $exists: false } }, { [sentField]: null }],
        },
        {
          $or: [
            { [lockField]: { $exists: false } },
            { [lockField]: null },
            { [lockField]: { $lt: staleBefore } },
          ],
        },
      ],
    },
    { $set: { [lockField]: new Date() } },
    { new: true }
  );
  return Boolean(updated);
};

const completeWhatsAppSend = async (orderId, key) => {
  if (!orderId || !key) return;
  await Order.updateOne(
    { _id: orderId },
    {
      $set: { [`whatsappSent.${key}`]: new Date() },
      $unset: { [`whatsappSending.${key}`]: 1 },
    }
  );
};

const failWhatsAppSend = async (orderId, key) => {
  if (!orderId || !key) return;
  await Order.updateOne(
    { _id: orderId },
    { $unset: { [`whatsappSending.${key}`]: 1 } }
  );
};

const orderPhone = (order) => {
  const raw = order?.contact || order?.phone || "";
  const digits = normalizePhone(raw);
  return digits.length >= 10 ? digits : "";
};

const buildConfirmedMessage = (order) => {
  const inv = invoiceLabel(order);
  const name = order.name || "there";
  return (
    `Hi ${name}! 👋\n\n` +
    `Your ${BRAND} order ${inv} is confirmed.\n` +
    `Amount: ${inr(order.totalAmount)}\n\n` +
    `We'll start preparing it shortly.\n` +
    `Track: ${storeUrl()}/order/${order._id}`
  );
};

const buildShippedMessage = (order) => {
  const inv = invoiceLabel(order);
  let tracking = "";
  if (order.trackingNumber) {
    tracking += `\nTracking number: ${order.trackingNumber}`;
  }
  if (order.trackingUrl) {
    tracking += `\nTrack shipment: ${order.trackingUrl}`;
  }
  return (
    `Good news! 🚚\n\n` +
    `Your ${BRAND} order ${inv} has been shipped.` +
    `${tracking}\n\n` +
    `Order details: ${storeUrl()}/order/${order._id}`
  );
};

const buildOutForDeliveryMessage = (order) => {
  const inv = invoiceLabel(order);
  return (
    `Almost there! 📦\n\n` +
    `Your ${BRAND} order ${inv} is out for delivery today.\n` +
    `Please keep your phone handy.\n\n` +
    `Order details: ${storeUrl()}/order/${order._id}`
  );
};

const buildDeliveredMessage = (order) => {
  const inv = invoiceLabel(order);
  return (
    `Delivered! ❤️\n\n` +
    `Your ${BRAND} order ${inv} has been delivered.\n` +
    `We'd love to know how you liked your purchase.\n\n` +
    `Write a review: ${storeUrl()}/order/${order._id}#write-review`
  );
};

const buildCancelledMessage = (order, { reason, refundStatus } = {}) => {
  const inv = invoiceLabel(order);
  const st = String(refundStatus || order?.refund?.status || "").toLowerCase();
  let refundLine = "Refund status will be updated shortly.";
  if (st === "completed") {
    refundLine =
      "Your refund has been completed. It may take a few business days to reflect.";
  } else if (st === "initiated") {
    refundLine =
      "A refund has been initiated. Funds typically reflect in 5–7 business days.";
  } else if (st === "failed") {
    refundLine =
      "Automatic refund needs a manual check — our team will process it. No action needed from you.";
  }
  return (
    `Order update\n\n` +
    `Your ${BRAND} order ${inv} has been cancelled.` +
    (reason ? `\nReason: ${reason}` : "") +
    `\n\n${refundLine}\n\n` +
    `Order details: ${storeUrl()}/order/${order._id}`
  );
};

const buildPaymentFailedMessage = ({ name, reason, amount, invoice } = {}) => {
  const inv = invoice != null && invoice !== "" ? `#${invoice}` : "";
  return (
    `Hi ${name || "there"},\n\n` +
    `Your ${BRAND} payment${inv ? ` for order ${inv}` : ""} could not be completed.` +
    (amount != null ? `\nAmount: ${inr(amount)}` : "") +
    (reason ? `\n${reason}` : "") +
    `\n\nYou can try again from your cart.\n${storeUrl()}/cart`
  );
};

/**
 * Send customer WhatsApp once per lifecycle key.
 * Never throws — failures are logged and left retryable.
 */
const sendLifecycleWhatsAppOnce = async (orderId, key, messageOrFn, order) => {
  if (!orderId || !key) return { sent: false, skipped: true };

  const phone = orderPhone(order);
  if (!phone) {
    console.warn(`[order-whatsapp] ${key}: no valid contact on order ${orderId}`);
    return { sent: false, skipped: true, reason: "no_phone" };
  }

  const claimed = await beginWhatsAppSend(orderId, key);
  if (!claimed) return { sent: false, skipped: true };

  try {
    const ready = await waitForWhatsAppConnected(3000);
    if (!ready) {
      throw new Error("WhatsApp is not connected. Scan QR in admin panel.");
    }

    const message =
      typeof messageOrFn === "function" ? messageOrFn(order) : String(messageOrFn || "");
    if (!message.trim()) {
      throw new Error("Empty WhatsApp message");
    }

    await sendWhatsAppText(phone, message);
    await completeWhatsAppSend(orderId, key);
    console.log(`[order-whatsapp] ${key} → ${phone}`);
    return { sent: true };
  } catch (err) {
    console.error(`[order-whatsapp] ${key}:`, err.message);
    await failWhatsAppSend(orderId, key);
    return { sent: false, error: err.message };
  }
};

const sendOrderConfirmedWhatsApp = (order) =>
  sendLifecycleWhatsAppOnce(
    order?._id,
    "confirmed",
    () => buildConfirmedMessage(order),
    order
  );

const sendOrderShippedWhatsApp = (order) =>
  sendLifecycleWhatsAppOnce(
    order?._id,
    "shipped",
    () => buildShippedMessage(order),
    order
  );

const sendOrderOutForDeliveryWhatsApp = (order) =>
  sendLifecycleWhatsAppOnce(
    order?._id,
    "out_for_delivery",
    () => buildOutForDeliveryMessage(order),
    order
  );

const sendOrderDeliveredWhatsApp = (order) =>
  sendLifecycleWhatsAppOnce(
    order?._id,
    "delivered",
    () => buildDeliveredMessage(order),
    order
  );

const sendOrderCancelledWhatsApp = (order, opts = {}) =>
  sendLifecycleWhatsAppOnce(
    order?._id,
    "cancelled",
    () => buildCancelledMessage(order, opts),
    order
  );

/**
 * Payment-failed has no Order document — best-effort, no idempotency key.
 */
const sendPaymentFailedWhatsApp = async ({ phone, name, reason, amount, invoice } = {}) => {
  const digits = normalizePhone(phone);
  if (!digits || digits.length < 10) {
    return { sent: false, skipped: true, reason: "no_phone" };
  }
  try {
    const ready = await waitForWhatsAppConnected(8000);
    if (!ready) {
      throw new Error("WhatsApp is not connected");
    }
    await sendWhatsAppText(
      digits,
      buildPaymentFailedMessage({ name, reason, amount, invoice })
    );
    return { sent: true };
  } catch (err) {
    console.error("[order-whatsapp] payment_failed:", err.message);
    return { sent: false, error: err.message };
  }
};

module.exports = {
  beginWhatsAppSend,
  completeWhatsAppSend,
  failWhatsAppSend,
  sendLifecycleWhatsAppOnce,
  sendOrderConfirmedWhatsApp,
  sendOrderShippedWhatsApp,
  sendOrderOutForDeliveryWhatsApp,
  sendOrderDeliveredWhatsApp,
  sendOrderCancelledWhatsApp,
  sendPaymentFailedWhatsApp,
  buildConfirmedMessage,
  buildShippedMessage,
  buildOutForDeliveryMessage,
  buildDeliveredMessage,
  buildCancelledMessage,
};
