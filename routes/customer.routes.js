const express = require("express");
const {
  getCustomers,
  getCustomerById,
  getCustomerActivity,
  syncCartActivity,
  updateCustomerStatus,
} = require("../controller/customer.controller");

const router = express.Router();

router.get("/", getCustomers);
router.post("/cart-activity", syncCartActivity);
router.get("/:id", getCustomerById);
router.get("/:id/activity", getCustomerActivity);
router.patch("/:id/status", updateCustomerStatus);

module.exports = router;
