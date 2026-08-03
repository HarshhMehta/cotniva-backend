const { secret } = require("../config/secret");

/**
 * CSRF-ish protection for cookie-based auth mutations.
 * Allows missing Origin on same-origin proxies; blocks unknown cross-origins.
 */
module.exports = function requireStoreOrigin(req, res, next) {
  const origin = req.get("origin") || "";
  const referer = req.get("referer") || "";

  const allowed = [
    secret.client_url,
    process.env.STORE_URL,
    process.env.CLIENT_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]
    .filter(Boolean)
    .map((u) => String(u).replace(/\/$/, ""));

  // Non-browser clients / same-server tools
  if (!origin && !referer) return next();

  const ok = allowed.some(
    (base) => origin.startsWith(base) || referer.startsWith(base)
  );

  if (!ok) {
    return res.status(403).json({
      success: false,
      message: "Invalid request origin",
    });
  }

  return next();
};
