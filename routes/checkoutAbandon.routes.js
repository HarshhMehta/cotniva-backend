const express = require("express");
const router = express.Router();
const {
  createAbandonFeedback,
  listAbandonFeedback,
} = require("../controller/checkoutAbandon.controller");

// Public — storefront submits exit survey
router.post("/", createAbandonFeedback);

// Admin list (same pattern as other list endpoints — token via admin panel)
router.get("/", listAbandonFeedback);

module.exports = router;
