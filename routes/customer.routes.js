const express = require("express");
const {
  getCustomers,
  getCustomerById,
  getCustomerActivity,
  syncCartActivity,
  updateCustomerStatus,
} = require("../controller/customer.controller");
const { requireAdmin } = require("../config/auth");
const verifyToken = require("../middleware/verifyToken");

const router = express.Router();

router.get("/", requireAdmin, getCustomers);
router.post("/cart-activity", verifyToken, syncCartActivity);
router.get("/:id", requireAdmin, getCustomerById);
router.get("/:id/activity", requireAdmin, getCustomerActivity);
router.patch("/:id/status", requireAdmin, updateCustomerStatus);

module.exports = router;
