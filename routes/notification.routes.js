const express = require("express");
const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  reportPaymentFailed,
  createManualNotification,
} = require("../controller/notification.controller");

const router = express.Router();

router.get("/", getNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", markAsRead);
router.post("/payment-failed", reportPaymentFailed);
router.post("/", createManualNotification);

module.exports = router;
