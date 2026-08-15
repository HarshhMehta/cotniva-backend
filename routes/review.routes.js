const express = require("express");
const multer = require("multer");
const router = express.Router();
const verifyToken = require("../middleware/verifyToken");
const { requireAdmin } = require("../config/auth");
const {
  createReview,
  addReview,
  getMyReviews,
  getOrderReviewState,
  getReviewById,
  updateMyReview,
  getProductReviews,
  adminReviewStats,
  adminListReviews,
  adminGetReview,
  adminUpdateStatus,
  adminDeleteReview,
  deleteReviews,
} = require("../controller/review.controller");

const reviewUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
    files: 3,
  },
  fileFilter: (req, file, cb) => {
    // Soft MIME gate; magic-byte validation happens in the controller
    const ok = /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype || "");
    if (!ok) {
      return cb(new Error("Only JPEG, PNG, or WEBP images are allowed"));
    }
    cb(null, true);
  },
});

const handleReviewUpload = (req, res, next) => {
  reviewUpload.array("images", 3)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          success: false,
          message: "You can upload at most 3 images",
          code: "TOO_MANY_IMAGES",
        });
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "Each image must be 4MB or smaller",
          code: "IMAGE_TOO_LARGE",
        });
      }
    }
    return res.status(400).json({
      success: false,
      message: err.message || "Invalid image upload",
      code: "INVALID_IMAGE",
    });
  });
};

// Public — approved reviews only
router.get("/product/:productId", getProductReviews);

// Admin (before /:id)
router.get("/admin/stats", requireAdmin, adminReviewStats);
router.get("/admin/list", requireAdmin, adminListReviews);
router.get("/admin/:id", requireAdmin, adminGetReview);
router.patch("/admin/:id/status", requireAdmin, adminUpdateStatus);
router.delete("/admin/:id", requireAdmin, adminDeleteReview);
router.delete("/delete/:id", requireAdmin, deleteReviews);

// Customer (authenticated)
router.post("/", verifyToken, handleReviewUpload, createReview);
router.post("/add", verifyToken, handleReviewUpload, addReview);
router.get("/my", verifyToken, getMyReviews);
router.get("/order/:orderId", verifyToken, getOrderReviewState);
router.patch("/:id", verifyToken, updateMyReview);
router.get("/:id", verifyToken, getReviewById);

module.exports = router;
