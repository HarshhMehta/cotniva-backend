const express = require("express");
const {
  paymentIntent,
  addOrder,
  getOrders,
  updateOrderStatus,
  emergencyCancelOrder,
  getOrderStatusMeta,
  getSingleOrder,
  createRazorpayOrder,
  createMagicCheckoutOrder,
  verifyRazorpayPayment,
  releaseMagicCheckoutStock,
  magicShippingInfo,
  magicGetPromotions,
  magicApplyPromotion,
  updateAdminNotes,
  syncRazorpayAddress,
  resendOrderConfirmed,
} = require("../controller/order.controller");
const { requireAdmin } = require("../config/auth");

const router = express.Router();

// Magic Checkout callbacks — must be before /:id
router.post("/magic/shipping-info", magicShippingInfo);
router.get("/magic/shipping-info", magicShippingInfo);
router.post("/magic/promotions", magicGetPromotions);
router.get("/magic/promotions", magicGetPromotions);
router.post("/magic/apply-promotion", magicApplyPromotion);

router.get("/orders", requireAdmin, getOrders);
router.get("/status-meta", getOrderStatusMeta);

// Razorpay
router.post("/create-razorpay-order", createRazorpayOrder);
router.post("/create-magic-checkout", createMagicCheckoutOrder);
router.post("/verify-razorpay", verifyRazorpayPayment);
router.post("/release-stock", releaseMagicCheckoutStock);

// legacy Stripe (disabled)
router.post("/create-payment-intent", paymentIntent);

router.post("/saveOrder", addOrder);
// Admin-only mutations (customer JWT → 403)
router.patch("/update-status/:id", requireAdmin, updateOrderStatus);
router.post("/:id/emergency-cancel", requireAdmin, emergencyCancelOrder);
router.patch("/update-notes/:id", requireAdmin, updateAdminNotes);
router.post("/sync-razorpay-address/:id", requireAdmin, syncRazorpayAddress);
router.post("/:id/resend-confirmed", requireAdmin, resendOrderConfirmed);

// single order — admin only (customers use /api/user-order/:id)
router.get("/:id", requireAdmin, getSingleOrder);

module.exports = router;
