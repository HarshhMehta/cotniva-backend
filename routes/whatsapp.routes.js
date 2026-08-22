const express = require("express");
const router = express.Router();
const whatsappAuth = require("../controller/whatsappAuth.controller");
const { requireAdmin } = require("../config/auth");

router.get("/status", requireAdmin, whatsappAuth.getWhatsAppStatus);
router.post("/connect", requireAdmin, whatsappAuth.connectWhatsAppSession);
router.post("/logout", requireAdmin, whatsappAuth.logoutWhatsAppSession);

router.post("/send-otp", whatsappAuth.sendLoginOtp);
router.post("/verify-otp", whatsappAuth.verifyLoginOtp);

module.exports = router;
