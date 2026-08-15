const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const REVIEW_STATUSES = ["pending", "approved", "rejected"];

/**
 * Verified-purchase product reviews.
 * Unique per (user, order, product) — same product can be reviewed again
 * on a different delivered order.
 */
const reviewSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    order: {
      type: ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    productId: {
      type: ObjectId,
      ref: "Products",
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: Number.isInteger,
        message: "Rating must be an integer",
      },
    },
    title: {
      type: String,
      default: "",
      trim: true,
      maxlength: [120, "Title is too long"],
    },
    comment: {
      type: String,
      default: "",
      trim: true,
      maxlength: [2000, "Comment is too long"],
    },
    status: {
      type: String,
      enum: REVIEW_STATUSES,
      default: "pending",
      lowercase: true,
      index: true,
    },
    isVerifiedPurchase: {
      type: Boolean,
      default: true,
    },
    /** Optional customer photos (Cloudinary URLs), max 3 */
    images: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length <= 3,
        message: "A review can have at most 3 images",
      },
    },
  },
  { timestamps: true }
);

reviewSchema.index(
  { userId: 1, order: 1, productId: 1 },
  { unique: true, name: "uniq_user_order_product_review" }
);

reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, createdAt: -1 });
reviewSchema.index({ rating: 1, status: 1 });

const Reviews =
  mongoose.models.Reviews || mongoose.model("Reviews", reviewSchema);

module.exports = Reviews;
module.exports.REVIEW_STATUSES = REVIEW_STATUSES;
