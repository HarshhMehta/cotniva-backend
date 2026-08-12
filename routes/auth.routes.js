const express = require("express");
const rateLimit = require("express-rate-limit");
const authController = require("../controller/auth.session.controller");
const verifyToken = require("../middleware/verifyToken");
const requireStoreOrigin = require("../middleware/require-store-origin");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many auth attempts. Please try again later.",
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again later.",
  },
});

router.post("/register", authLimiter, requireStoreOrigin, authController.register);
router.post("/login", loginLimiter, requireStoreOrigin, authController.login);
router.post("/refresh", authLimiter, requireStoreOrigin, authController.refresh);
router.post("/logout", requireStoreOrigin, authController.logout);
router.post("/logout-all", verifyToken, requireStoreOrigin, authController.logoutAll);
router.get("/me", verifyToken, authController.me);
router.post(
  "/change-password",
  verifyToken,
  requireStoreOrigin,
  authController.changePassword
);

module.exports = router;
