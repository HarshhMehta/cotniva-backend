const express = require("express");
const {
  paymentIntent,
  addOrder,
  getOrders,
  updateOrderStatus,
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
} = require("../controller/order.controller");

const router = express.Router();

// Magic Checkout callbacks — must be before /:id
router.post("/magic/shipping-info", magicShippingInfo);
router.get("/magic/shipping-info", magicShippingInfo);
router.post("/magic/promotions", magicGetPromotions);
router.get("/magic/promotions", magicGetPromotions);
router.post("/magic/apply-promotion", magicApplyPromotion);

router.get("/orders", getOrders);

// Razorpay
router.post("/create-razorpay-order", createRazorpayOrder);
router.post("/create-magic-checkout", createMagicCheckoutOrder);
router.post("/verify-razorpay", verifyRazorpayPayment);
router.post("/release-stock", releaseMagicCheckoutStock);

// legacy Stripe (disabled)
router.post("/create-payment-intent", paymentIntent);

router.post("/saveOrder", addOrder);
router.patch("/update-status/:id", updateOrderStatus);
router.patch("/update-notes/:id", updateAdminNotes);
router.post("/sync-razorpay-address/:id", syncRazorpayAddress);

// single order last
router.get("/:id", getSingleOrder);

module.exports = router;
