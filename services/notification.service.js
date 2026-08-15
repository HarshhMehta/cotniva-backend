const EventEmitter = require("events");
const Notification = require("../model/Notification");
const { sendOrderFailedEmails } = require("./order-email.service");
const NOTIFICATION_TYPES = Notification.NOTIFICATION_TYPES;

const notificationBus = new EventEmitter();
notificationBus.setMaxListeners(50);

const createNotification = async ({
  title,
  message,
  type,
  relatedOrderId,
  relatedCustomerId,
  meta = {},
}) => {
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`Invalid notification type: ${type}`);
  }

  const doc = await Notification.create({
    title,
    message,
    type,
    relatedOrderId: relatedOrderId || undefined,
    relatedCustomerId: relatedCustomerId || undefined,
    isRead: false,
    meta,
  });

  const plain = doc.toObject ? doc.toObject() : doc;
  notificationBus.emit("notification:created", plain);
  return plain;
};

const notifyNewOrder = async (order, extraType) => {
  const invoice = order?.invoice != null ? `#${order.invoice}` : "";
  const amount = Number(order?.totalAmount || 0).toLocaleString("en-IN");
  const name = order?.name || "Customer";
  const customerId = order?.user?._id || order?.user || null;
  const type = extraType || "new_order";

  const titles = {
    new_order: `New order ${invoice}`.trim(),
    payment_success: `Payment success ${invoice}`.trim(),
    cod_order: `COD order ${invoice}`.trim(),
  };
  const messages = {
    new_order: `${name} placed an order for ₹${amount}`,
    payment_success: `${name} paid ₹${amount} · order confirmed ${invoice}`.trim(),
    cod_order: `Cash on delivery order from ${name} · ₹${amount}`,
  };

  // In-app only — emails are sent via order-status / claimEmailSlot
  return createNotification({
    title: titles[type] || titles.new_order,
    message: messages[type] || messages.new_order,
    type: titles[type] ? type : "new_order",
    relatedOrderId: order?._id,
    relatedCustomerId: customerId,
    meta: {
      invoice: order?.invoice,
      paymentMethod: order?.paymentMethod,
      paymentStatus: order?.paymentStatus,
      totalAmount: order?.totalAmount,
      status: order?.status,
    },
  });
};

const notifyPaymentFailed = async ({
  relatedCustomerId,
  reason,
  amount,
  email,
  name,
  invoice,
  paymentMethod,
  meta = {},
} = {}) => {
  const doc = await createNotification({
    title: "Payment failed",
    message: reason || "A customer payment attempt failed",
    type: "payment_failed",
    relatedCustomerId: relatedCustomerId || undefined,
    meta: { amount, email, name, invoice, ...meta },
  });

  sendOrderFailedEmails({
    email,
    name,
    reason,
    amount,
    invoice,
    paymentMethod,
    meta,
  }).catch((e) => console.error("order failed email:", e.message));

  return doc;
};

const notifyOrderCancelled = async (order) => {
  const invoice = order?.invoice != null ? `#${order.invoice}` : "";
  return createNotification({
    title: `Order cancelled ${invoice}`.trim(),
    message: `Order ${invoice || order?._id} was cancelled${
      order?.cancellation?.reason ? ` · ${order.cancellation.reason}` : ""
    }`,
    type: "order_cancelled",
    relatedOrderId: order?._id,
    relatedCustomerId: order?.user?._id || order?.user || undefined,
    meta: {
      invoice: order?.invoice,
      status: "cancelled",
      refundStatus: order?.refund?.status,
      reason: order?.cancellation?.reason,
    },
  });
};

module.exports = {
  notificationBus,
  createNotification,
  notifyNewOrder,
  notifyPaymentFailed,
  notifyOrderCancelled,
  NOTIFICATION_TYPES,
};
