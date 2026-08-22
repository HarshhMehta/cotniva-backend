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
    },
    minimumAmount: {
      type: Number,
      required: true,
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
