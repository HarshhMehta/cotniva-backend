const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../config/auth");
const {
  subscribe,
  verify,
  getUnsubscribeInfo,
  unsubscribe,
  adminStats,
  adminList,
  adminCampaignList,
  adminSendTest,
  adminSendCampaign,
  adminResendBlocked,
} = require("../controller/newsletter.controller");

// Public
router.post("/subscribe", subscribe);
router.get("/verify/:token", verify);
router.get("/unsubscribe/:token", getUnsubscribeInfo);
router.post("/unsubscribe/:token", unsubscribe);

// Admin
router.get("/admin/stats", requireAdmin, adminStats);
router.get("/admin/list", requireAdmin, adminList);
router.get("/admin/campaigns", requireAdmin, adminCampaignList);
router.post("/admin/campaigns/test", requireAdmin, adminSendTest);
router.post("/admin/campaigns/send", requireAdmin, adminSendCampaign);
router.post("/admin/campaigns/:id/send", requireAdmin, adminResendBlocked);

module.exports = router;
