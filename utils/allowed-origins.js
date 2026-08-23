const { secret } = require("../config/secret");

/**
 * Normalize and expand store/admin origins for CORS + CSRF checks.
 * Supports comma-separated STORE_URL / CLIENT_URL / ALLOWED_ORIGINS.
 */
function expandEnvUrls(...values) {
  const out = [];
  for (const value of values) {
    if (!value) continue;
    String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((u) => out.push(u.replace(/\/$/, "")));
  }
  return out;
}

function getStoreOrigins() {
  return [
    ...expandEnvUrls(
      secret.client_url,
      process.env.STORE_URL,
      process.env.CLIENT_URL,
      process.env.ALLOWED_ORIGINS
    ),
    "https://cotniva.vercel.app",
    "https://cotniva.com",
    "https://www.cotniva.com",
    "http://localhost:3000",
    "http://localhost:3001",

  ];
}

function getAdminOrigins() {
  return [
    ...expandEnvUrls(secret.admin_url, process.env.ADMIN_URL),
    "http://localhost:3001",
    "http://localhost:3002",
    "https://cotniva-admin.vercel.app",
    "https://cotnivastore.cotniva.com"
  ];
}

function isAllowedOrigin(origin, list) {
  if (!origin) return false;
  const o = String(origin).replace(/\/$/, "");
  return list.some((base) => o === base || o.startsWith(`${base}/`));
}

module.exports = {
  getStoreOrigins,
  getAdminOrigins,
  isAllowedOrigin,
  expandEnvUrls,
};
