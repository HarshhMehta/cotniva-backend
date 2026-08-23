const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const couponSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    logo: {
      type: String,
      required: false,
      default: "",
    },
    couponCode: {
      type: String,
      required: true,
    },
    startTime: {
      type: Date,
      required: false,
    },
    endTime: {
      type: Date,
      required: false,
      default: null,
    },
    neverExpires: {
      type: Boolean,
      default: false,
    },
    discountPercentage: {
      type: Number,
      required: true,
      default: 0,
    },
    /** percentage | fixed (₹ off) */
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      default: "percentage",
    },
    /** Flat rupee discount when discountType is fixed */
    discountAmount: {
      type: Number,
      required: false,
      default: 0,
    },
    minimumAmount: {
      type: Number,
      required: true,
    },
    /**
     * Max total redemptions across all customers (store-wide cap).
     * null / undefined / 0 = unlimited
     */
    maxUses: {
      type: Number,
      required: false,
      default: null,
    },
    /**
     * Max times a single customer can use this code (by user id or checkout email).
     * null / undefined / 0 = unlimited per customer
     */
    maxUsesPerUser: {
      type: Number,
      required: false,
      default: null,
    },
    /** How many times this coupon has been successfully applied on an order */
    usedCount: {
      type: Number,
      required: false,
      default: 0,
    },
    /**
     * Legacy field. New coupons use "all" when store-wide,
     * or keep older productType values for backward compatibility.
     */
    productType: {
      type: String,
      required: false,
      default: "all",
    },
    /**
     * Empty = applies to all products.
     * Non-empty = discount only on products whose category.id is listed.
     */
    applicableCategories: {
      type: [
        {
          type: ObjectId,
          ref: "Category",
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

const Coupon = mongoose.models.Coupon || mongoose.model("Coupon", couponSchema);
module.exports = Coupon;
