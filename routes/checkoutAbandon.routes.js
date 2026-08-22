const express = require("express");
const router = express.Router();
const {
  createAbandonFeedback,
  listAbandonFeedback,
} = require("../controller/checkoutAbandon.controller");
const { requireAdmin } = require("../config/auth");

router.post("/", createAbandonFeedback);
router.get("/", requireAdmin, listAbandonFeedback);

module.exports = router;
