const mongoose = require("mongoose");

/**
 * Per-payment idempotency + automatic refund audit trail.
 * Not used for emergency-cancel (that updates Order.refund directly).
 */
const paymentAttemptSchema = new mongoose.Schema(
  {
    razorpay_payment_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    razorpay_order_id: { type: String, default: "", index: true },
    status: {
      type: String,
      enum: [
        "idle",
        "persisting",
        "order_created",
        "refund_pending",
        "refunded",
        "failed",
        "skipped",
      ],
      default: "idle",
      index: true,
    },
    /** Lock expiry — stale locks can be reclaimed after this time */
    persistLockUntil: { type: Date, default: null },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    refundId: { type: String, default: "" },
    lastReason: { type: String, default: "" },
    lastSource: { type: String, default: "" },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.PaymentAttempt ||
  mongoose.model("PaymentAttempt", paymentAttemptSchema);
