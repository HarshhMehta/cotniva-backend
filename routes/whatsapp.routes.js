const express = require("express");
const router = express.Router();
const whatsappAuth = require("../controller/whatsappAuth.controller");

// Admin WhatsApp session
router.get("/status", whatsappAuth.getWhatsAppStatus);
router.post("/logout", whatsappAuth.logoutWhatsAppSession);

// Customer OTP login
router.post("/send-otp", whatsappAuth.sendLoginOtp);
router.post("/verify-otp", whatsappAuth.verifyLoginOtp);

module.exports = router;
