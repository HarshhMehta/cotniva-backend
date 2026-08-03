const mongoose = require("mongoose");

const ACTIVITY_TYPES = [
  "registration",
  "login",
  "cart_updated",
  "order_placed",
];

const customerActivitySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ACTIVITY_TYPES,
      required: true,
      index: true,
    },
    meta: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

customerActivitySchema.index({ user: 1, createdAt: -1 });

const CustomerActivity =
  mongoose.models.CustomerActivity ||
  mongoose.model("CustomerActivity", customerActivitySchema);

CustomerActivity.ACTIVITY_TYPES = ACTIVITY_TYPES;

module.exports = CustomerActivity;
