const EventEmitter = require("events");
const Notification = require("../model/Notification");
const NOTIFICATION_TYPES = Notification.NOTIFICATION_TYPES;

/**
 * In-process bus — Socket.io (or any realtime layer) can subscribe later:
 *   notificationBus.on("notification:created", (doc) => io.emit(...))
 * Business logic always goes through createNotification / helpers.
 */
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
    payment_success: `${name} paid ₹${amount} via Razorpay ${invoice}`.trim(),
    cod_order: `Cash on delivery order from ${name} · ₹${amount}`,
  };

  return createNotification({
    title: titles[type] || titles.new_order,
    message: messages[type] || messages.new_order,
    type: titles[type] ? type : "new_order",
    relatedOrderId: order?._id,
    relatedCustomerId: customerId,
    meta: {
      invoice: order?.invoice,
      paymentMethod: order?.paymentMethod,
      totalAmount: order?.totalAmount,
    },
  });
};

const notifyPaymentFailed = async ({
  relatedCustomerId,
  reason,
  amount,
  meta = {},
} = {}) => {
  return createNotification({
    title: "Payment failed",
    message: reason || "A customer payment attempt failed",
    type: "payment_failed",
    relatedCustomerId: relatedCustomerId || undefined,
    meta: { amount, ...meta },
  });
};

const notifyOrderCancelled = async (order) => {
  const invoice = order?.invoice != null ? `#${order.invoice}` : "";
  return createNotification({
    title: `Order cancelled ${invoice}`.trim(),
    message: `Order ${invoice || order?._id} was cancelled`,
    type: "order_cancelled",
    relatedOrderId: order?._id,
    relatedCustomerId: order?.user?._id || order?.user || undefined,
    meta: { invoice: order?.invoice, status: "cancel" },
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
