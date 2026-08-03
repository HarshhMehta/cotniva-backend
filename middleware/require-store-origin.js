const {
  getStoreOrigins,
  isAllowedOrigin,
} = require("../utils/allowed-origins");

/**
 * CSRF-ish protection for cookie-based auth mutations.
 * Allows missing Origin on same-origin proxies; blocks unknown cross-origins.
 */
module.exports = function requireStoreOrigin(req, res, next) {
  const origin = (req.get("origin") || "").replace(/\/$/, "");
  const referer = req.get("referer") || "";
  const allowed = getStoreOrigins();

  // Non-browser clients / same-server tools
  if (!origin && !referer) return next();

  const ok =
    (origin && isAllowedOrigin(origin, allowed)) ||
    allowed.some((base) => referer.startsWith(base));

  if (!ok) {
    return res.status(403).json({
      success: false,
      message: "Invalid request origin",
    });
  }

  return next();
};
