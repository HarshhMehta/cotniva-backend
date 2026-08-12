const mongoose = require("mongoose");

/**
 * Tracks inventory reserved at Magic Checkout create, before payment.
 * held → committed on verify/webhook, or released on cancel/payment abort/TTL.
 */
const stockHoldSchema = new mongoose.Schema(
  {
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    releaseToken: {
      type: String,
      required: true,
      index: true,
    },
    lines: [
      {
        productId: { type: String, required: true },
        selectedSize: { type: String, default: "" },
        qty: { type: Number, required: true },
        mode: { type: String, enum: ["size", "legacy"], required: true },
      },
    ],
    status: {
      type: String,
      enum: ["held", "committed", "released"],
      default: "held",
    },
    sellCountApplied: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    orderDraft: {
      type: Object,
      required: false,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.StockHold || mongoose.model("StockHold", stockHoldSchema);
