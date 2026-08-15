const mongoose = require("mongoose");

const FULFILLMENT_STATUSES = [
  "pending", // legacy only
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancel", // legacy spelling
  "cancelled",
];

const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];

const REFUND_STATUSES = [
  "not_required",
  "pending",
  "initiated",
  "completed",
  "failed",
];

const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ["system", "payment", "admin", "webhook", "migration"],
      default: "system",
    },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    adminEmail: { type: String },
    reason: { type: String },
    note: { type: String },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    cart: [{}],
    name: { type: String, required: true },
    address: { type: String, required: true },
    email: { type: String, required: true },
    contact: { type: String, required: true },
    city: { type: String, required: true },
    country: { type: String, required: true },
    zipCode: { type: String, required: true },
    subTotal: { type: Number, required: true },
    shippingCost: { type: Number, required: true },
    discount: { type: Number, required: true, default: 0 },
    totalAmount: { type: Number, required: true },
    shippingOption: { type: String, required: false },
    cardInfo: { type: Object, required: false },
    paymentIntent: { type: Object, required: false },
    paymentMethod: { type: String, required: true },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "pending",
      lowercase: true,
      index: true,
    },
    orderNote: { type: String, required: false },
    adminNotes: { type: String, required: false, default: "" },
    invoice: { type: Number, unique: true },
    status: {
      type: String,
      enum: FULFILLMENT_STATUSES,
      lowercase: true,
      default: "confirmed",
      index: true,
    },
    statusHistory: { type: [statusHistorySchema], default: [] },
    emailsSent: { type: Object, default: {} },
    trackingNumber: { type: String, default: "" },
    trackingUrl: { type: String, default: "" },
    cancellation: {
      reason: { type: String, default: "" },
      reasonCode: { type: String, default: "" },
      cancelledAt: { type: Date },
      cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
      cancelledByEmail: { type: String, default: "" },
    },
    refund: {
      status: {
        type: String,
        enum: REFUND_STATUSES,
        default: "not_required",
        lowercase: true,
      },
      razorpayRefundId: { type: String, default: "" },
      amount: { type: Number },
      initiatedAt: { type: Date },
      completedAt: { type: Date },
      failedAt: { type: Date },
      error: { type: String, default: "" },
      lastAttemptAt: { type: Date },
      source: { type: String, default: "" },
      reason: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

orderSchema.index(
  { "paymentIntent.razorpay_payment_id": 1 },
  { unique: true, sparse: true }
);
orderSchema.index(
  { "paymentIntent.razorpay_order_id": 1 },
  { unique: true, sparse: true }
);

orderSchema.pre("save", async function (next) {
  const order = this;
  if (!order.invoice) {
    try {
      const highestInvoice = await mongoose
        .model("Order")
        .find({})
        .sort({ invoice: "desc" })
        .limit(1)
        .select({ invoice: 1 });
      order.invoice =
        highestInvoice.length === 0 ? 1000 : highestInvoice[0].invoice + 1;
      next();
    } catch (error) {
      next(error);
    }
  } else {
    next();
  }
});

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);

Order.FULFILLMENT_STATUSES = FULFILLMENT_STATUSES;
Order.PAYMENT_STATUSES = PAYMENT_STATUSES;
Order.REFUND_STATUSES = REFUND_STATUSES;

module.exports = Order;
