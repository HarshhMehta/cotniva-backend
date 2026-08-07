const mongoose = require("mongoose");

const checkoutAbandonSchema = new mongoose.Schema(
  {
    reasons: {
      type: [String],
      default: [],
    },
    stillCancel: {
      type: Boolean,
      default: true,
    },
    page: {
      type: String,
      default: "checkout",
    },
    phone: String,
    email: String,
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cartTotal: {
      type: Number,
      default: 0,
    },
    cartCount: {
      type: Number,
      default: 0,
    },
    cartSnapshot: {
      type: Array,
      default: [],
    },
    userAgent: String,
  },
  {
    timestamps: true,
    collection: "checkout_abandons",
  }
);

checkoutAbandonSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.CheckoutAbandon ||
  mongoose.model("CheckoutAbandon", checkoutAbandonSchema);
