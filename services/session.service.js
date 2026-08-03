const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const RefreshToken = require("../model/RefreshToken");
const { secret } = require("../config/secret");

const ACCESS_COOKIE = "cotniva_access";
const REFRESH_COOKIE = "cotniva_refresh";
const ACCESS_TTL = "15m";
const ACCESS_MS = 15 * 60 * 1000;
const REFRESH_DAYS = 30;
const REFRESH_MS = REFRESH_DAYS * 24 * 60 * 60 * 1000;

const isProd = () =>
  String(secret.env || process.env.NODE_ENV || "").toLowerCase() ===
  "production";

const hashToken = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

const generateAccessToken = (user) => {
  const payload = {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
    type: "access",
  };
  return jwt.sign(payload, secret.token_secret, { expiresIn: ACCESS_TTL });
};

const generateRefreshRaw = () => crypto.randomBytes(48).toString("hex");

const cookieOptions = (maxAgeMs) => ({
  httpOnly: true,
  secure: isProd(),
  sameSite: isProd() ? "none" : "lax",
  path: "/",
  maxAge: maxAgeMs,
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
});

const clearCookieOptions = () => ({
  httpOnly: true,
  secure: isProd(),
  sameSite: isProd() ? "none" : "lax",
  path: "/",
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
});

const getClientMeta = (req) => {
  const deviceId =
    req.get("x-device-id") ||
    req.body?.deviceId ||
    req.cookies?.cotniva_device ||
    "unknown";
  const userAgent = req.get("user-agent") || "";
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.ip ||
    "";
  return { deviceId: String(deviceId).slice(0, 128), userAgent, ip };
};

const publicUser = (user) => {
  const obj = typeof user.toObject === "function" ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.confirmationToken;
  delete obj.confirmationTokenExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  return obj;
};

/**
 * Create refresh token row + set auth cookies + return access token + user.
 */
const issueSession = async (req, res, user) => {
  const { deviceId, userAgent, ip } = getClientMeta(req);
  const accessToken = generateAccessToken(user);
  const refreshRaw = generateRefreshRaw();
  const tokenHash = hashToken(refreshRaw);
  const expiresAt = new Date(Date.now() + REFRESH_MS);

  // One active session per device — replace older for same device
  await RefreshToken.deleteMany({ user: user._id, deviceId });

  await RefreshToken.create({
    user: user._id,
    tokenHash,
    deviceId,
    userAgent,
    ip,
    expiresAt,
  });

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false }).catch(() => {});

  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_MS));
  res.cookie(REFRESH_COOKIE, refreshRaw, cookieOptions(REFRESH_MS));

  return {
    accessToken,
    user: publicUser(user),
    expiresIn: ACCESS_MS / 1000,
  };
};

/**
 * Rotate refresh token; issue new access + refresh cookies.
 */
const rotateRefreshSession = async (req, res, rawRefresh) => {
  const tokenHash = hashToken(rawRefresh);
  const existing = await RefreshToken.findOne({ tokenHash }).populate("user");

  if (!existing || existing.revokedAt) {
    const err = new Error("Invalid refresh token");
    err.statusCode = 401;
    throw err;
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    await RefreshToken.deleteOne({ _id: existing._id });
    const err = new Error("Refresh token expired");
    err.statusCode = 401;
    throw err;
  }

  const { deviceId } = getClientMeta(req);
  if (existing.deviceId && deviceId !== "unknown" && existing.deviceId !== deviceId) {
    // Soft check — allow if device unknown to avoid locking out old clients,
    // but reject hard mismatches (replay from another device id).
    await RefreshToken.updateOne(
      { _id: existing._id },
      { $set: { revokedAt: new Date() } }
    );
    const err = new Error("Session device mismatch");
    err.statusCode = 401;
    throw err;
  }

  const user = existing.user;
  if (!user || user.status === "blocked") {
    await RefreshToken.deleteMany({ user: existing.user });
    const err = new Error("Account unavailable");
    err.statusCode = 403;
    throw err;
  }

  // Rotate: revoke old, create new
  const newRaw = generateRefreshRaw();
  const newHash = hashToken(newRaw);
  const expiresAt = new Date(Date.now() + REFRESH_MS);

  existing.revokedAt = new Date();
  existing.replacedByHash = newHash;
  await existing.save();

  await RefreshToken.create({
    user: user._id,
    tokenHash: newHash,
    deviceId: existing.deviceId || deviceId,
    userAgent: req.get("user-agent") || existing.userAgent,
    ip:
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.ip ||
      existing.ip,
    expiresAt,
  });

  const accessToken = generateAccessToken(user);
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_MS));
  res.cookie(REFRESH_COOKIE, newRaw, cookieOptions(REFRESH_MS));

  return {
    accessToken,
    user: publicUser(user),
    expiresIn: ACCESS_MS / 1000,
  };
};

const clearSessionCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE, clearCookieOptions());
  res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
};

const revokeCurrentRefresh = async (rawRefresh) => {
  if (!rawRefresh) return;
  const tokenHash = hashToken(rawRefresh);
  await RefreshToken.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

const revokeAllUserSessions = async (userId) => {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

const readAccessFromRequest = (req) => {
  const header = req.headers?.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return req.cookies?.[ACCESS_COOKIE] || null;
};

const readRefreshFromRequest = (req) =>
  req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken || null;

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_MS,
  REFRESH_MS,
  hashToken,
  generateAccessToken,
  issueSession,
  rotateRefreshSession,
  clearSessionCookies,
  revokeCurrentRefresh,
  revokeAllUserSessions,
  readAccessFromRequest,
  readRefreshFromRequest,
  publicUser,
  getClientMeta,
};
