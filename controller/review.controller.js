const mongoose = require("mongoose");
const Review = require("../model/Review");
const Order = require("../model/Order");
const Products = require("../model/Products");
const User = require("../model/User");
const {
  MAX_REVIEW_IMAGES,
  processReviewImageFiles,
  processReviewImageUrls,
} = require("../utils/review-images");

const TITLE_MAX = 120;
const COMMENT_MAX = 2000;

const toObjectId = (id) => {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return new mongoose.Types.ObjectId(String(id));
};

const idStr = (v) => (v == null ? "" : String(v));

const orderContainsProduct = (order, productId) => {
  const pid = idStr(productId);
  if (!pid || !order?.cart) return false;
  return order.cart.some((item) => idStr(item?._id) === pid);
};

const sanitizeText = (v, max) =>
  String(v || "")
    .trim()
    .slice(0, max);

const parseRating = (raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
};

const httpError = (message, statusCode, code) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
};

/**
 * Enforce: auth user owns delivered order that contains product.
 */
const assertEligibleReview = async ({ userId, orderId, productId }) => {
  const uid = toObjectId(userId);
  const oid = toObjectId(orderId);
  const pid = toObjectId(productId);
  if (!uid || !oid || !pid) {
    throw httpError("Invalid review identifiers", 400, "INVALID_IDS");
  }

  const order = await Order.findById(oid);
  if (!order) throw httpError("Order not found", 404, "ORDER_NOT_FOUND");

  if (idStr(order.user) !== idStr(uid)) {
    throw httpError("You cannot review this order", 403, "NOT_OWNER");
  }

  if (String(order.status || "").toLowerCase() !== "delivered") {
    throw httpError(
      "You can only review products after the order is delivered",
      403,
      "NOT_DELIVERED"
    );
  }

  if (!orderContainsProduct(order, pid)) {
    throw httpError(
      "This product was not purchased in this order",
      400,
      "PRODUCT_NOT_IN_ORDER"
    );
  }

  const product = await Products.findById(pid).select("_id title img imageURLs");
  if (!product) throw httpError("Product not found", 404, "PRODUCT_NOT_FOUND");

  return { order, product, userId: uid, orderId: oid, productId: pid };
};

const attachReviewRefs = async (review) => {
  try {
    await Products.updateOne(
      { _id: review.productId },
      { $addToSet: { reviews: review._id } }
    );
  } catch {
    /* non-fatal */
  }
  try {
    await User.updateOne(
      { _id: review.userId },
      { $addToSet: { reviews: review._id } }
    );
  } catch {
    /* non-fatal */
  }
};

const publicReviewShape = (doc) => {
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  return o;
};

/** Customer-facing payload — never expose admin moderation status */
const customerReviewShape = (doc) => {
  const o = publicReviewShape(doc);
  return {
    _id: o._id,
    userId: o.userId,
    order: o.order,
    productId: o.productId,
    rating: o.rating,
    title: o.title || "",
    comment: o.comment || "",
    images: Array.isArray(o.images) ? o.images : [],
    isVerifiedPurchase: Boolean(o.isVerifiedPurchase),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
};

const resolveReviewImages = async (req) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length > MAX_REVIEW_IMAGES) {
    const err = new Error(`You can upload at most ${MAX_REVIEW_IMAGES} images`);
    err.statusCode = 400;
    err.code = "TOO_MANY_IMAGES";
    throw err;
  }
  if (files.length) {
    return processReviewImageFiles(files);
  }
  if (req.body?.images != null && req.body.images !== "") {
    return processReviewImageUrls(req.body.images);
  }
  return [];
};

/** POST /api/review  (also /add) */
exports.createReview = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "You are not logged in",
      });
    }

    const orderId = req.body.orderId || req.body.order;
    const productId = req.body.productId || req.body.product;
    const rating = parseRating(req.body.rating);
    if (rating == null) {
      return res.status(400).json({
        success: false,
        message: "Rating must be an integer from 1 to 5",
        code: "INVALID_RATING",
      });
    }

    const title = sanitizeText(req.body.title, TITLE_MAX);
    const comment = sanitizeText(req.body.comment, COMMENT_MAX);
    const images = await resolveReviewImages(req);

    const { orderId: oid, productId: pid, userId: uid } =
      await assertEligibleReview({ userId, orderId, productId });

    const existing = await Review.findOne({
      userId: uid,
      order: oid,
      productId: pid,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You already submitted a review for this product in this order",
        code: "DUPLICATE_REVIEW",
        review: customerReviewShape(existing),
      });
    }

    let review;
    try {
      review = await Review.create({
        userId: uid,
        order: oid,
        productId: pid,
        rating,
        title,
        comment,
        images,
        status: "pending",
        isVerifiedPurchase: true,
      });
    } catch (err) {
      if (err?.code === 11000) {
        const again = await Review.findOne({
          userId: uid,
          order: oid,
          productId: pid,
        });
        return res.status(409).json({
          success: false,
          message: "You already submitted a review for this product in this order",
          code: "DUPLICATE_REVIEW",
          review: again ? customerReviewShape(again) : undefined,
        });
      }
      throw err;
    }

    await attachReviewRefs(review);

    res.status(201).json({
      success: true,
      message: "Thank you for your review",
      review: customerReviewShape(review),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }
    next(error);
  }
};

/** Legacy alias used by old PDP form — requires orderId now for verified purchase */
exports.addReview = exports.createReview;

/** GET /api/review/my */
exports.getMyReviews = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    const list = await Review.find({ userId })
      .sort({ createdAt: -1 })
      .populate("productId", "title img imageURLs slug")
      .populate("order", "invoice status")
      .lean();
    res.status(200).json({
      success: true,
      data: list.map(customerReviewShape),
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/review/order/:orderId — eligibility + existing reviews for order */
exports.getOrderReviewState = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    const orderId = toObjectId(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (idStr(order.user) !== idStr(userId)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const delivered =
      String(order.status || "").toLowerCase() === "delivered";
    const reviews = await Review.find({
      userId,
      order: orderId,
    }).lean();

    const byProduct = {};
    for (const r of reviews) {
      byProduct[idStr(r.productId)] = r;
    }

    const items = (order.cart || []).map((item) => {
      const pid = idStr(item._id);
      const existing = byProduct[pid] || null;
      return {
        productId: pid,
        title: item.title || item.name || "Product",
        img: item.img || item.imageURLs?.[0]?.img || "",
        canReview: delivered && Boolean(pid) && !existing,
        review: existing ? customerReviewShape(existing) : null,
      };
    });

    res.status(200).json({
      success: true,
      delivered,
      items,
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/review/:id */
exports.getReviewById = async (req, res, next) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const review = await Review.findById(id)
      .populate("productId", "title img imageURLs")
      .populate("order", "invoice status")
      .populate("userId", "name email");
    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found" });
    }

    const isOwner = idStr(review.userId?._id || review.userId) === idStr(req.user?._id);
    const isApproved = review.status === "approved";
    if (!isOwner && !isApproved) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const payload = isOwner
      ? customerReviewShape(review)
      : publicReviewShape(review);

    res.status(200).json({ success: true, review: payload });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/review/:id — reviews are immutable after submit */
exports.updateMyReview = async (req, res) => {
  return res.status(405).json({
    success: false,
    message: "Reviews cannot be edited after submission",
    code: "EDIT_NOT_ALLOWED",
  });
};

/** GET /api/review/product/:productId — approved only + summary */
exports.getProductReviews = async (req, res, next) => {
  try {
    const productId = toObjectId(req.params.productId);
    if (!productId) {
      return res.status(400).json({ success: false, message: "Invalid product id" });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const filter = { productId, status: "approved" };
    const [items, total, agg] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name imageURL")
        .lean(),
      Review.countDocuments(filter),
      Review.aggregate([
        { $match: { productId, status: "approved" } },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$rating" },
            count: { $sum: 1 },
            r1: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
            r2: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
            r3: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
            r4: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
            r5: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const summary = agg[0] || {
      avgRating: 0,
      count: 0,
      r1: 0,
      r2: 0,
      r3: 0,
      r4: 0,
      r5: 0,
    };

    res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
      summary: {
        averageRating: Number((summary.avgRating || 0).toFixed(2)),
        totalReviews: summary.count || 0,
        distribution: {
          5: summary.r5 || 0,
          4: summary.r4 || 0,
          3: summary.r3 || 0,
          2: summary.r2 || 0,
          1: summary.r1 || 0,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Admin stats */
exports.adminReviewStats = async (req, res, next) => {
  try {
    const [byStatus, byRating, avg] = await Promise.all([
      Review.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Review.aggregate([
        { $group: { _id: "$rating", count: { $sum: 1 } } },
      ]),
      Review.aggregate([
        { $group: { _id: null, avg: { $avg: "$rating" }, total: { $sum: 1 } } },
      ]),
    ]);

    const statusMap = { pending: 0, approved: 0, rejected: 0 };
    for (const row of byStatus) {
      if (row._id) statusMap[row._id] = row.count;
    }
    const ratingMap = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of byRating) {
      if (row._id >= 1 && row._id <= 5) ratingMap[row._id] = row.count;
    }

    res.status(200).json({
      success: true,
      data: {
        total: avg[0]?.total || 0,
        pending: statusMap.pending,
        approved: statusMap.approved,
        rejected: statusMap.rejected,
        averageRating: Number((avg[0]?.avg || 0).toFixed(2)),
        ratingBreakdown: ratingMap,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Admin list with filters + search + pagination */
exports.adminListReviews = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const status = String(req.query.status || "").toLowerCase();
    const rating = Number(req.query.rating);
    const q = String(req.query.q || "").trim();

    const filter = {};
    if (["pending", "approved", "rejected"].includes(status)) {
      filter.status = status;
    }
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      filter.rating = rating;
    }

    if (q) {
      const users = await User.find({
        $or: [
          { name: { $regex: q, $options: "i" } },
          { email: { $regex: q, $options: "i" } },
        ],
      })
        .select("_id")
        .limit(50)
        .lean();
      const products = await Products.find({
        title: { $regex: q, $options: "i" },
      })
        .select("_id")
        .limit(50)
        .lean();
      const invoiceNum = Number(q.replace(/\D/g, ""));
      const orders = await Order.find({
        $or: [
          ...(Number.isFinite(invoiceNum) && invoiceNum > 0
            ? [{ invoice: invoiceNum }]
            : []),
          ...(mongoose.Types.ObjectId.isValid(q) ? [{ _id: q }] : []),
        ],
      })
        .select("_id")
        .limit(50)
        .lean();

      filter.$or = [
        { userId: { $in: users.map((u) => u._id) } },
        { productId: { $in: products.map((p) => p._id) } },
        { order: { $in: orders.map((o) => o._id) } },
        { title: { $regex: q, $options: "i" } },
        { comment: { $regex: q, $options: "i" } },
      ];
    }

    const [data, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email imageURL")
        .populate("productId", "title img imageURLs")
        .populate("order", "invoice status")
        .lean(),
      Review.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Admin get one */
exports.adminGetReview = async (req, res, next) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const review = await Review.findById(id)
      .populate("userId", "name email phone imageURL")
      .populate("productId", "title img imageURLs")
      .populate("order", "invoice status totalAmount");
    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found" });
    }
    res.status(200).json({ success: true, review });
  } catch (error) {
    next(error);
  }
};

/** PATCH status approve/reject */
exports.adminUpdateStatus = async (req, res, next) => {
  try {
    const id = toObjectId(req.params.id);
    const nextStatus = String(req.body.status || "").toLowerCase();
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    if (!["pending", "approved", "rejected"].includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: "status must be pending, approved, or rejected",
      });
    }

    const review = await Review.findByIdAndUpdate(
      id,
      { $set: { status: nextStatus } },
      { new: true }
    )
      .populate("userId", "name email")
      .populate("productId", "title img imageURLs")
      .populate("order", "invoice");

    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found" });
    }

    res.status(200).json({
      success: true,
      message: `Review marked ${nextStatus}`,
      review,
    });
  } catch (error) {
    next(error);
  }
};

/** Admin delete single review by review id */
exports.adminDeleteReview = async (req, res, next) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const review = await Review.findByIdAndDelete(id);
    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found" });
    }
    await Products.updateOne(
      { _id: review.productId },
      { $pull: { reviews: review._id } }
    ).catch(() => {});
    await User.updateOne(
      { _id: review.userId },
      { $pull: { reviews: review._id } }
    ).catch(() => {});

    res.status(200).json({ success: true, message: "Review deleted" });
  } catch (error) {
    next(error);
  }
};

/** Legacy wipe-by-product — keep but admin-only */
exports.deleteReviews = async (req, res, next) => {
  try {
    const productId = toObjectId(req.params.id);
    if (!productId) {
      return res.status(400).json({ success: false, message: "Invalid product id" });
    }
    const result = await Review.deleteMany({ productId });
    await Products.updateOne({ _id: productId }, { $set: { reviews: [] } }).catch(
      () => {}
    );
    res.json({
      success: true,
      message: "All reviews deleted for the product",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    next(error);
  }
};

module.exports.helpers = {
  assertEligibleReview,
  orderContainsProduct,
  parseRating,
  toObjectId,
  customerReviewShape,
  resolveReviewImages,
};
