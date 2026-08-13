const Otp = require("../model/Otp");
const User = require("../model/User");
const {
  startWhatsApp,
  getStatus,
  sendWhatsAppText,
  waitForWhatsAppConnected,
  logoutWhatsApp,
  normalizePhone,
} = require("../services/whatsapp.service");
const { trackCustomerActivity } = require("../services/customer-activity.service");
const { issueSession } = require("../services/session.service");

const generateOtp = () =>
  String(Math.floor(100000 + Math.random() * 900000));

const phoneEmail = (phone) => `${phone}@gmail.com`;

// Admin: start session / get QR + status
exports.getWhatsAppStatus = async (req, res, next) => {
  try {
    // Read-only — never start a socket here (admin polls this every few seconds)
    const status = getStatus();
    res.status(200).json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
};

/** Explicit connect / reclaim — used by admin "Connect" / "Refresh QR" only */
exports.connectWhatsAppSession = async (req, res, next) => {
  try {
    await startWhatsApp({ force: true });
    await new Promise((r) => setTimeout(r, 600));
    const status = getStatus();
    res.status(200).json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
};

exports.logoutWhatsAppSession = async (req, res, next) => {
  try {
    await logoutWhatsApp();
    res.status(200).json({
      success: true,
      message: "WhatsApp disconnected. Scan QR again to reconnect.",
    });
  } catch (error) {
    next(error);
  }
};

// Customer: send OTP via WhatsApp
exports.sendLoginOtp = async (req, res, next) => {
  try {
    const { phone } = req.body || {};
    const normalized = normalizePhone(phone);

    if (!normalized || normalized.length < 12) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 10-digit mobile number",
      });
    }

    const connected = await waitForWhatsAppConnected(4000);
    if (!connected) {
      const currentStatus = getStatus().status;
      return res.status(503).json({
        success: false,
        message:
          currentStatus === "qr"
            ? "WhatsApp needs to be reconnected by the store. Please use Google login or try again shortly."
            : "WhatsApp is reconnecting. Please wait a few seconds and try again.",
      });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await Otp.deleteMany({ phone: normalized });
    await Otp.create({ phone: normalized, otp, expiresAt });

    const message = `Your Cotniva login OTP is *${otp}*. Valid for 5 minutes. Do not share this code with anyone.`;

    try {
      await sendWhatsAppText(normalized, message);
    } catch (sendErr) {
      console.error("WhatsApp OTP delivery failed:", {
        phone: normalized,
        code: sendErr.code,
        message: sendErr.message,
      });
      await Otp.deleteMany({ phone: normalized });

      if (sendErr.code === "WA_NOT_REGISTERED") {
        return res.status(400).json({
          success: false,
          message:
            "This number is not on WhatsApp. Please use a WhatsApp number or Google login.",
        });
      }

      return res.status(503).json({
        success: false,
        message:
          "Could not send WhatsApp OTP. Please try again or use Google login.",
      });
    }

    res.status(200).json({
      success: true,
      message: "OTP sent to your WhatsApp",
      data: {
        phone: normalized,
        masked: `******${normalized.slice(-4)}`,
      },
    });
  } catch (error) {
    console.error("sendLoginOtp error:", error.message);
    next(error);
  }
};

// Customer: verify OTP and login / register
exports.verifyLoginOtp = async (req, res, next) => {
  try {
    const { phone, otp } = req.body || {};
    const normalized = normalizePhone(phone);

    if (!normalized || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone and OTP are required",
      });
    }

    const record = await Otp.findOne({ phone: normalized }).sort({
      createdAt: -1,
    });

    if (!record) {
      return res.status(400).json({
        success: false,
        message: "OTP expired or not found. Please request a new one.",
      });
    }

    if (new Date() > new Date(record.expiresAt)) {
      await Otp.deleteMany({ phone: normalized });
      return res.status(400).json({
        success: false,
        message: "OTP expired. Please request a new one.",
      });
    }

    if (String(record.otp) !== String(otp).trim()) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP. Please try again.",
      });
    }

    await Otp.deleteMany({ phone: normalized });

    let user = await User.findOne({ phone: normalized });

    if (!user) {
      // also check contactNumber for older accounts
      user = await User.findOne({ contactNumber: normalized });
    }

    if (!user) {
      user = await User.create({
        name: `User ${normalized.slice(-4)}`,
        email: phoneEmail(normalized),
        phone: normalized,
        contactNumber: normalized,
        status: "active",
      });
      trackCustomerActivity(user._id, "registration", {
        source: "whatsapp_otp",
      }).catch(() => {});
    } else {
      if (user.status === "blocked") {
        return res.status(403).json({
          success: false,
          message: "Your account has been blocked.",
        });
      }
      user.phone = normalized;
      user.contactNumber = user.contactNumber || normalized;
      user.status = "active";
      await user.save({ validateBeforeSave: false });
    }

    trackCustomerActivity(user._id, "login", { source: "whatsapp_otp" }).catch(
      () => {}
    );

    const session = await issueSession(req, res, user);

    res.status(200).json({
      success: true,
      status: "success",
      message: "Successfully logged in",
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
