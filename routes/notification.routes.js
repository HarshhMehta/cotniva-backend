const express = require("express");
const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  reportPaymentFailed,
  createManualNotification,
} = require("../controller/notification.controller");
const { requireAdmin } = require("../config/auth");

const router = express.Router();

router.get("/", requireAdmin, getNotifications);
router.get("/unread-count", requireAdmin, getUnreadCount);
router.patch("/read-all", requireAdmin, markAllAsRead);
router.patch("/:id/read", requireAdmin, markAsRead);
router.post("/payment-failed", reportPaymentFailed);
router.post("/", requireAdmin, createManualNotification);

module.exports = router;
