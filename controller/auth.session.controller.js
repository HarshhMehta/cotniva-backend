const User = require("../model/User");
const {
  issueSession,
  rotateRefreshSession,
  clearSessionCookies,
  revokeCurrentRefresh,
  revokeAllUserSessions,
  readRefreshFromRequest,
  publicUser,
} = require("../services/session.service");
const { trackCustomerActivity } = require("../services/customer-activity.service");

const sanitizeUserInput = (body = {}) => ({
  name: String(body.name || "").trim(),
  email: String(body.email || "").trim().toLowerCase(),
  password: String(body.password || ""),
  phone: body.phone ? String(body.phone).replace(/\D/g, "") : undefined,
});

exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = sanitizeUserInput(req.body);
    if (!name || name.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Name must be at least 3 characters",
      });
    }
    if (!email || !password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Valid email and password (min 6 chars) are required",
      });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    const user = await User.create({
      name,
      email,
      password,
      status: "active",
    });

    trackCustomerActivity(user._id, "registration", {
      source: "email_signup",
    }).catch(() => {});

    const session = await issueSession(req, res, user);

    res.status(201).json({
      success: true,
      status: "success",
      message: "Account created",
      data: {
        user: session.user,
        token: session.accessToken,
        expiresIn: session.expiresIn,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = sanitizeUserInput(req.body);
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const ok = user.comparePassword(password, user.password);
    if (!ok) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (user.status === "blocked") {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked",
      });
    }

    if (user.status === "inactive") {
      user.status = "active";
      await user.save({ validateBeforeSave: false });
    }

    trackCustomerActivity(user._id, "login", { source: "email" }).catch(
      () => {}
    );

    const session = await issueSession(req, res, user);

    res.status(200).json({
      success: true,
      status: "success",
      message: "Logged in successfully",
      data: {
        user: session.user,
        token: session.accessToken,
        expiresIn: session.expiresIn,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.refresh = async (req, res, next) => {
  try {
    const raw = readRefreshFromRequest(req);
    if (!raw) {
      clearSessionCookies(res, req);
      return res.status(401).json({
        success: false,
        code: "NO_REFRESH_TOKEN",
        message: "No refresh token",
      });
    }

    const session = await rotateRefreshSession(req, res, raw);

    res.status(200).json({
      success: true,
      status: "success",
      message: session.alreadyRotated
        ? "Session already refreshed"
        : "Session refreshed",
      code: session.alreadyRotated ? "ALREADY_ROTATED" : undefined,
      data: {
        user: session.user,
        token: session.accessToken,
        expiresIn: session.expiresIn,
      },
    });
  } catch (error) {
    // Only wipe cookies for genuine session death — not rotation races
    if (error.clearCookies) {
      clearSessionCookies(res, req);
    }
    const status = error.statusCode || 401;
    res.status(status).json({
      success: false,
      code: error.code || "REFRESH_FAILED",
      message: error.message || "Could not refresh session",
    });
  }
};

exports.logout = async (req, res, next) => {
  try {
    const raw = readRefreshFromRequest(req);
    await revokeCurrentRefresh(raw);
    clearSessionCookies(res, req);
    res.status(200).json({
      success: true,
      message: "Logged out",
    });
  } catch (error) {
    clearSessionCookies(res, req);
    next(error);
  }
};

exports.logoutAll = async (req, res, next) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }
    await revokeAllUserSessions(req.user._id);
    clearSessionCookies(res, req);
    res.status(200).json({
      success: true,
      message: "Logged out from all devices",
    });
  } catch (error) {
    next(error);
  }
};

exports.me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }
    if (user.status === "blocked") {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked",
      });
    }
    res.status(200).json({
      success: true,
      data: { user: publicUser(user) },
    });
  } catch (error) {
    next(error);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    const { currentPassword, newPassword } = req.body || {};

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.password) {
      const ok = user.comparePassword(
        String(currentPassword || ""),
        user.password
      );
      if (!ok) {
        return res.status(401).json({
          success: false,
          message: "Current password is incorrect",
        });
      }
    }

    user.password = String(newPassword);
    user.passwordChangedAt = new Date();
    await user.save();

    // Force re-login everywhere
    await revokeAllUserSessions(user._id);
    clearSessionCookies(res, req);

    res.status(200).json({
      success: true,
      message: "Password updated. Please log in again on all devices.",
    });
  } catch (error) {
    next(error);
  }
};

/** Attach session cookies for existing login flows (WhatsApp / Google). */
exports.attachSessionToResponse = issueSession;
