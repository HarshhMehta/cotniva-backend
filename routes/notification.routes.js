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
const { bindPatchOrPost } = require("../utils/patch-or-post");
const patchOrPost = bindPatchOrPost(router);

router.get("/", requireAdmin, getNotifications);
router.get("/unread-count", requireAdmin, getUnreadCount);
patchOrPost("/read-all", requireAdmin, markAllAsRead);
patchOrPost("/:id/read", requireAdmin, markAsRead);
router.post("/payment-failed", reportPaymentFailed);
router.post("/", requireAdmin, createManualNotification);

module.exports = router;
