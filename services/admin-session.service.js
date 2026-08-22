const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Admin = require("../model/Admin");
const AdminRefreshToken = require("../model/AdminRefreshToken");
const { secret } = require("../config/secret");
const {
  hashToken,
  getClientMeta,
  useCrossSiteCookies,
} = require("./session.service");

const ADMIN_ACCESS_COOKIE = "cotniva_admin_access";
const ADMIN_REFRESH_COOKIE = "cotniva_admin_refresh";
const ADMIN_ACCESS_TTL = "2d";
const ADMIN_ACCESS_MS = 2 * 24 * 60 * 60 * 1000;
const ADMIN_REFRESH_DAYS = 14;
const ADMIN_REFRESH_MS = ADMIN_REFRESH_DAYS * 24 * 60 * 60 * 1000;

const ADMIN_ROLES = new Set(["Admin", "Super Admin", "Manager", "CEO"]);

/**
 * Lightweight check — true when request carries a valid admin access token.
 * Used to allow full catalog reads for admin-panel without exposing them publicly.
 */
const verifyAdminAccessRequest = async (req) => {
  try {
    const token = readAdminAccessFromRequest(req);
    if (!token) return false;
    const decoded = jwt.verify(token, secret.token_secret);
    if (decoded?.type && decoded.type !== "admin_access") return false;
    if (!decoded?._id) return false;
    const admin = await Admin.findById(decoded._id)
      .select("_id role status")
      .lean();
    if (!admin || String(admin.status || "Active") !== "Active") return false;
    if (admin.role && !ADMIN_ROLES.has(admin.role)) return false;
    return true;
  } catch {
    return false;
  }
};

const isProd = () =>
  String(secret.env || process.env.NODE_ENV || "").toLowerCase() ===
  "production";

const requestIsHttps = (req) => {
  if (!req) return false;
  const xf = String(req.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (xf === "https") return true;
  if (req.secure) return true;
  return String(req.protocol || "").toLowerCase() === "https";
};

const baseCookieFlags = (req) => {
  const crossSite = useCrossSiteCookies(req);
  const secure = crossSite || requestIsHttps(req) || isProd();
  return {
    httpOnly: true,
    secure,
    sameSite: crossSite ? "none" : "lax",
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
};

const cookieOptions = (maxAgeMs, req) => ({
  ...baseCookieFlags(req),
  maxAge: maxAgeMs,
});

const clearCookieOptions = (req) => baseCookieFlags(req);

const publicAdmin = (admin) => {
  const obj =
    typeof admin.toObject === "function" ? admin.toObject() : { ...admin };
  delete obj.password;
  delete obj.confirmationToken;
  delete obj.confirmationTokenExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  return obj;
};

const generateAdminAccessToken = (admin) =>
  jwt.sign(
    {
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      type: "admin_access",
    },
    secret.token_secret,
    { expiresIn: ADMIN_ACCESS_TTL }
  );

const generateAdminRefreshRaw = () => crypto.randomBytes(48).toString("hex");

const readAdminAccessFromRequest = (req) =>
  req.cookies?.[ADMIN_ACCESS_COOKIE] || null;

const readAdminRefreshFromRequest = (req) =>
  req.cookies?.[ADMIN_REFRESH_COOKIE] || req.body?.refreshToken || null;

const issueAdminSession = async (req, res, admin) => {
  const { deviceId, userAgent, ip } = getClientMeta(req);
  const accessToken = generateAdminAccessToken(admin);
  const refreshRaw = generateAdminRefreshRaw();
  const tokenHash = hashToken(refreshRaw);
  const expiresAt = new Date(Date.now() + ADMIN_REFRESH_MS);

  await AdminRefreshToken.deleteMany({ admin: admin._id, deviceId });

  await AdminRefreshToken.create({
    admin: admin._id,
    tokenHash,
    deviceId,
    userAgent,
    ip,
    expiresAt,
  });

  res.cookie(ADMIN_ACCESS_COOKIE, accessToken, cookieOptions(ADMIN_ACCESS_MS, req));
  res.cookie(
    ADMIN_REFRESH_COOKIE,
    refreshRaw,
    cookieOptions(ADMIN_REFRESH_MS, req)
  );

  return { user: publicAdmin(admin) };
};

const clearAdminSessionCookies = (res, req) => {
  const primary = clearCookieOptions(req);
  res.clearCookie(ADMIN_ACCESS_COOKIE, primary);
  res.clearCookie(ADMIN_REFRESH_COOKIE, primary);

  const legacy = {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
  res.clearCookie(ADMIN_ACCESS_COOKIE, legacy);
  res.clearCookie(ADMIN_REFRESH_COOKIE, legacy);

  const cross = {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
  res.clearCookie(ADMIN_ACCESS_COOKIE, cross);
  res.clearCookie(ADMIN_REFRESH_COOKIE, cross);
};

const revokeAdminRefresh = async (rawRefresh) => {
  if (!rawRefresh) return;
  const tokenHash = hashToken(rawRefresh);
  await AdminRefreshToken.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

const revokeAllAdminSessions = async (adminId) => {
  await AdminRefreshToken.updateMany(
    { admin: adminId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

const rotateAdminRefreshSession = async (req, res, rawRefresh) => {
  const tokenHash = hashToken(rawRefresh);
  const preview = await AdminRefreshToken.findOne({ tokenHash }).populate(
    "admin"
  );

  if (!preview || preview.expiresAt.getTime() < Date.now()) {
    throw Object.assign(new Error("Invalid refresh token"), {
      statusCode: 401,
      code: "INVALID_REFRESH",
    });
  }
  if (preview.revokedAt) {
    throw Object.assign(new Error("Invalid refresh token"), {
      statusCode: 401,
      code: "REFRESH_REVOKED",
    });
  }

  const admin = preview.admin;
  if (!admin || String(admin.status) === "Inactive") {
    throw Object.assign(new Error("Admin account unavailable"), {
      statusCode: 403,
    });
  }

  const newRaw = generateAdminRefreshRaw();
  const newHash = hashToken(newRaw);
  const expiresAt = new Date(Date.now() + ADMIN_REFRESH_MS);

  const claimed = await AdminRefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date(), replacedByHash: newHash } },
    { new: false }
  );
  if (!claimed) {
    throw Object.assign(new Error("Invalid refresh token"), {
      statusCode: 401,
    });
  }

  await AdminRefreshToken.create({
    admin: admin._id,
    tokenHash: newHash,
    deviceId: preview.deviceId,
    userAgent: preview.userAgent,
    ip: preview.ip,
    expiresAt,
  });

  const accessToken = generateAdminAccessToken(admin);
  res.cookie(ADMIN_ACCESS_COOKIE, accessToken, cookieOptions(ADMIN_ACCESS_MS, req));
  res.cookie(ADMIN_REFRESH_COOKIE, newRaw, cookieOptions(ADMIN_REFRESH_MS, req));

  return { user: publicAdmin(admin) };
};

module.exports = {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  ADMIN_ACCESS_MS,
  publicAdmin,
  generateAdminAccessToken,
  readAdminAccessFromRequest,
  readAdminRefreshFromRequest,
  issueAdminSession,
  clearAdminSessionCookies,
  revokeAdminRefresh,
  revokeAllAdminSessions,
  rotateAdminRefreshSession,
  verifyAdminAccessRequest,
};
