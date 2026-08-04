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

/**
 * Cross-site store (Vercel) → API host needs SameSite=None; Secure.
 *
 * Evidence from production DevTools: cookies were issued as SameSite=Lax /
 * Secure=false because NODE_ENV was not "production" on the API host.
 * Lax cookies are NOT sent on cross-site fetch() from cotniva.vercel.app
 * → /api/auth/me returns 401 after every refresh.
 *
 * Detect from the live request when possible so we never depend on NODE_ENV alone.
 */
const useCrossSiteCookies = (req) => {
  const flag = String(process.env.CROSS_SITE_COOKIES || "").toLowerCase();
  if (flag === "false" || flag === "0") return false;
  if (flag === "true" || flag === "1") return true;
  if (String(process.env.COOKIE_SAMESITE || "").toLowerCase() === "none") {
    return true;
  }
  if (isProd()) return true;

  if (req) {
    const origin = String(req.get?.("origin") || "").trim();
    if (origin.startsWith("https://")) {
      try {
        const originHost = new URL(origin).hostname;
        const apiHost = String(req.hostname || req.get?.("host") || "")
          .split(":")[0]
          .toLowerCase();
        // Different host + https Origin = browser will treat cookies as cross-site
        if (originHost && apiHost && originHost !== apiHost) {
          return true;
        }
      } catch {
        return true;
      }
    }
    // HTTPS API behind a proxy (Render) — prefer cross-site-safe cookies
    if (requestIsHttps(req) && origin.startsWith("http")) {
      // http localhost → https API is also cross-site; need None+Secure
      // but Secure cookies work on https API responses
      try {
        const originHost = new URL(origin).hostname;
        const apiHost = String(req.hostname || "").split(":")[0];
        if (originHost && apiHost && originHost !== apiHost) return true;
      } catch {
        /* ignore */
      }
    }
  }

  return false;
};

const baseCookieFlags = (req) => {
  const crossSite = useCrossSiteCookies(req);
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? "none" : "lax",
    path: "/",
    // Never set Domain to the Vercel host — cookie must be host-only on the API.
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
};

const cookieOptions = (maxAgeMs, req) => ({
  ...baseCookieFlags(req),
  maxAge: maxAgeMs,
});

const clearCookieOptions = (req) => baseCookieFlags(req);

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

const sessionError = (message, statusCode, code, clearCookies = true) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.clearCookies = clearCookies;
  return err;
};

/**
 * Concurrent refresh lost the race: old token already rotated.
 * Re-issue access cookie only; do not clear refresh (winner set it).
 */
const resumeAfterRotationRace = async (req, res, revokedDoc) => {
  if (!revokedDoc?.replacedByHash) return null;

  const replacement = await RefreshToken.findOne({
    tokenHash: revokedDoc.replacedByHash,
    revokedAt: null,
  }).populate("user");

  if (
    !replacement ||
    replacement.expiresAt.getTime() < Date.now() ||
    !replacement.user ||
    replacement.user.status === "blocked"
  ) {
    return null;
  }

  const accessToken = generateAccessToken(replacement.user);
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_MS, req));
  // Refresh cookie already updated by the winning request — leave it alone.

  return {
    accessToken,
    user: publicUser(replacement.user),
    expiresIn: ACCESS_MS / 1000,
    alreadyRotated: true,
  };
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

  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_MS, req));
  res.cookie(REFRESH_COOKIE, refreshRaw, cookieOptions(REFRESH_MS, req));

  return {
    accessToken,
    user: publicUser(user),
    expiresIn: ACCESS_MS / 1000,
  };
};

/**
 * Rotate refresh token; issue new access + refresh cookies.
 * Uses atomic claim so only one concurrent refresh wins; losers resume
 * without clearing cookies (ALREADY_ROTATED soft-success path).
 */
const rotateRefreshSession = async (req, res, rawRefresh) => {
  const tokenHash = hashToken(rawRefresh);
  const { deviceId } = getClientMeta(req);

  const preview = await RefreshToken.findOne({ tokenHash }).populate("user");

  if (!preview) {
    throw sessionError("Invalid refresh token", 401, "INVALID_REFRESH", true);
  }

  if (preview.expiresAt.getTime() < Date.now()) {
    await RefreshToken.deleteOne({ _id: preview._id }).catch(() => {});
    throw sessionError("Refresh token expired", 401, "REFRESH_EXPIRED", true);
  }

  if (preview.revokedAt) {
    const resumed = await resumeAfterRotationRace(req, res, preview);
    if (resumed) return resumed;
    throw sessionError("Invalid refresh token", 401, "REFRESH_REVOKED", true);
  }

  if (
    preview.deviceId &&
    deviceId !== "unknown" &&
    preview.deviceId !== deviceId
  ) {
    await RefreshToken.updateOne(
      { _id: preview._id },
      { $set: { revokedAt: new Date() } }
    );
    throw sessionError(
      "Session device mismatch",
      401,
      "DEVICE_MISMATCH",
      true
    );
  }

  const user = preview.user;
  if (!user || user.status === "blocked") {
    await RefreshToken.deleteMany({ user: preview.user }).catch(() => {});
    throw sessionError(
      "Account unavailable",
      403,
      "ACCOUNT_UNAVAILABLE",
      true
    );
  }

  const newRaw = generateRefreshRaw();
  const newHash = hashToken(newRaw);
  const expiresAt = new Date(Date.now() + REFRESH_MS);

  // Atomic win: only one request can claim a non-revoked token
  const claimed = await RefreshToken.findOneAndUpdate(
    {
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        revokedAt: new Date(),
        replacedByHash: newHash,
      },
    },
    { new: false }
  );

  if (!claimed) {
    // Lost race after preview — soft-resume
    const existing = await RefreshToken.findOne({ tokenHash });
    const resumed = await resumeAfterRotationRace(req, res, existing);
    if (resumed) return resumed;
    throw sessionError(
      "Invalid refresh token",
      401,
      "REFRESH_REUSE",
      false // do not clear — sibling may have just set cookies
    );
  }

  await RefreshToken.create({
    user: user._id,
    tokenHash: newHash,
    deviceId: preview.deviceId || deviceId,
    userAgent: req.get("user-agent") || preview.userAgent,
    ip:
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.ip ||
      preview.ip,
    expiresAt,
  });

  const accessToken = generateAccessToken(user);
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_MS, req));
  res.cookie(REFRESH_COOKIE, newRaw, cookieOptions(REFRESH_MS, req));

  return {
    accessToken,
    user: publicUser(user),
    expiresIn: ACCESS_MS / 1000,
  };
};

/**
 * Clear auth cookies. Clears both cross-site and lax variants so stale
 * SameSite=Lax cookies left by older deploys are actually removed.
 */
const clearSessionCookies = (res, req) => {
  const primary = clearCookieOptions(req);
  res.clearCookie(ACCESS_COOKIE, primary);
  res.clearCookie(REFRESH_COOKIE, primary);

  // Purge legacy Lax/non-Secure cookies from misconfigured NODE_ENV deploys
  const legacy = {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
  res.clearCookie(ACCESS_COOKIE, legacy);
  res.clearCookie(REFRESH_COOKIE, legacy);

  const cross = {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
  res.clearCookie(ACCESS_COOKIE, cross);
  res.clearCookie(REFRESH_COOKIE, cross);
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
  useCrossSiteCookies,
};
