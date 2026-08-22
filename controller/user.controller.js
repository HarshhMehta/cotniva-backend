const { publicUser } = require("../utils/sanitize-user");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../model/User");
const { sendEmail } = require("../config/email");
const { generateToken, tokenForVerify } = require("../utils/token");
const {
  createPasswordResetFields,
  findByPasswordResetToken,
  clearPasswordResetFields,
} = require("../utils/password-reset-token");
const { secret } = require("../config/secret");
const { trackCustomerActivity } = require("../services/customer-activity.service");
const { issueSession } = require("../services/session.service");

// register user
// sign up
exports.signup = async (req, res,next) => {
  try {
    const user = await User.findOne({ email: req.body.email });
    if (user) {
      res.send({ status: "failed", message: "Email already exists" });
    } else {
      const saved_user = await User.create({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        phone: req.body.phone,
      });
      const token = saved_user.generateConfirmationToken();

      await saved_user.save({ validateBeforeSave: false });
      trackCustomerActivity(saved_user._id, "registration", {
        source: "email_signup",
      }).catch(() => {});

      const mailData = {
        from: secret.email_user,
        to: `${req.body.email}`,
        subject: "Email Activation",
        subject: "Verify Your Email",
        html: `<h2>Hello ${req.body.name}</h2>
        <p>Verify your email address to complete the signup and login into your <strong>shofy</strong> account.</p>
  
          <p>This link will expire in <strong> 10 minute</strong>.</p>
  
          <p style="margin-bottom:20px;">Click this link for active your account</p>
  
          <a href="${secret.client_url}/email-verify/${token}" style="background:#0989FF;color:white;border:1px solid #0989FF; padding: 10px 15px; border-radius: 4px; text-decoration:none;">Verify Account</a>
  
          <p style="margin-top: 35px;">If you did not initiate this request, please contact us immediately at support@shofy.com</p>
  
          <p style="margin-bottom:0px;">Thank you</p>
          <strong>shofy Team</strong>
           `,
      };
      const message = "Please check your email to verify!";
      sendEmail(mailData, res, message);
    }
  } catch (error) {
    next(error)
  }
};

/**
 * 1. Check if Email and password are given
 * 2. Load user with email
 * 3. if not user send res
 * 4. compare password
 * 5. if password not correct send res
 * 6. check if user is active
 * 7. if not active send res
 * 8. generate token
 * 9. send user and token
 */
module.exports.login = async (req, res,next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(401).json({
        status: "fail",
        error: "Please provide your credentials",
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({
        status: "fail",
        error: "No user found. Please create an account",
      });
    }

    const isPasswordValid = user.comparePassword(password, user.password);

    if (!isPasswordValid) {
      return res.status(403).json({
        status: "fail",
        error: "Password is not correct",
      });
    }

    if (user.status != "active") {
      return res.status(401).json({
        status: "fail",
        error: "Your account is not active yet.",
      });
    }

    trackCustomerActivity(user._id, "login", { source: "email" }).catch(() => {});

    const session = await issueSession(req, res, user);

    res.status(200).json({
      status: "success",
      message: "Successfully logged in",
      data: {
        user: session.user,
        token: session.accessToken,
        expiresIn: session.expiresIn,
      },
    });
  } catch (error) {
    next(error)
  }
};

// confirmEmail
exports.confirmEmail = async (req, res,next) => {
  try {
    const { token } = req.params;
    const user = await User.findOne({ confirmationToken: token });

    if (!user) {
      return res.status(403).json({
        status: "fail",
        error: "Invalid token",
      });
    }

    const expired = new Date() > new Date(user.confirmationTokenExpires);

    if (expired) {
      return res.status(401).json({
        status: "fail",
        error: "Token expired",
      });
    }

    user.status = "active";
    user.confirmationToken = undefined;
    user.confirmationTokenExpires = undefined;

    await user.save({ validateBeforeSave: false });

    const accessToken = generateToken(user);

    const { password: pwd, ...others } = user.toObject();

    res.status(200).json({
      status: "success",
      message: "Successfully activated your account.",
      data: {
        user: others,
        token: accessToken,
      },
    });
  } catch (error) {
    next(error)
  }
};

// forgetPassword
exports.forgetPassword = async (req, res,next) => {
  try {
    const { verifyEmail } = req.body;
    const user = await User.findOne({ email: verifyEmail });
    if (!user) {
      return res.status(404).send({
        message: "User Not found with this email!",
      });
    } else {
      const reset = createPasswordResetFields();
      const body = {
        from: secret.email_user,
        to: `${verifyEmail}`,
        subject: "Password Reset",
        html: `<h2>Hello ${verifyEmail}</h2>
        <p>A request has been received to change the password for your <strong>Shofy</strong> account </p>

        <p>This link will expire in <strong> 10 minute</strong>.</p>

        <p style="margin-bottom:20px;">Click this link for reset your password</p>

        <a href=${secret.client_url}/forget-password/${reset.rawToken} style="background:#0989FF;color:white;border:1px solid #0989FF; padding: 10px 15px; border-radius: 4px; text-decoration:none;">Reset Password</a>

        <p style="margin-top: 35px;">If you did not initiate this request, please contact us immediately at support@shofy.com</p>

        <p style="margin-bottom:0px;">Thank you</p>
        <strong>Shofy Team</strong>
        `,
      };
      user.passwordResetToken = reset.passwordResetToken;
      user.passwordResetExpires = reset.passwordResetExpires;
      user.confirmationToken = undefined;
      user.confirmationTokenExpires = undefined;
      await user.save({ validateBeforeSave: false });
      const message = "Please check your email to reset password!";
      sendEmail(body, res, message);
    }
  } catch (error) {
    next(error)
  }
};

// confirm-forget-password
exports.confirmForgetPassword = async (req, res,next) => {
  try {
    const { token, password } = req.body;
    if (!password || String(password).length < 6) {
      return res.status(400).json({
        status: "fail",
        error: "Password must be at least 6 characters",
      });
    }

    const user = await findByPasswordResetToken(User, token);

    if (!user) {
      return res.status(403).json({
        status: "fail",
        error: "Invalid or expired token",
      });
    }

    user.password = bcrypt.hashSync(password);
    clearPasswordResetFields(user);
    await user.save({ validateBeforeSave: false });

    return res.status(200).json({
      status: "success",
      message: "Password reset successfully",
    });
  } catch (error) {
    next(error)
  }
};

// change password — requires authenticated session; identity from token only
exports.changePassword = async (req, res, next) => {
  try {
    const actorId = String(req.user?._id || req.user?.id || "");
    if (!actorId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const { password, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters",
      });
    }

    const user = await User.findById(actorId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Google-only accounts without a local password may set one once
    const hasLocalPassword =
      user.password && String(user.password).length > 0;

    if (hasLocalPassword) {
      if (!password || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ message: "Incorrect current password" });
      }
    }

    user.password = bcrypt.hashSync(newPassword);
    await user.save({ validateBeforeSave: false });
    return res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    next(error);
  }
};

// update a profile
exports.updateUser = async (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    const actorId = String(req.user?._id || req.user?.id || "");
    if (actorId && actorId !== String(userId)) {
      return res.status(403).json({
        status: "fail",
        success: false,
        message: "You can only update your own profile",
      });
    }

    const normalizePhone = (raw = "") => {
      let d = String(raw || "").replace(/\D/g, "");
      if (d.startsWith("91") && d.length >= 12) d = d.slice(-10);
      else if (d.startsWith("0") && d.length >= 11) d = d.replace(/^0+/, "");
      else if (d.length > 10) d = d.slice(-10);
      if (d.startsWith("0") && d.length === 10) d = d.slice(1);
      return d.slice(0, 10);
    };

    if (req.body.name !== undefined && String(req.body.name).trim()) {
      const name = String(req.body.name).trim();
      if (name.length >= 3) user.name = name;
    }
    if (req.body.email !== undefined && String(req.body.email).trim()) {
      const email = String(req.body.email).trim().toLowerCase();
      const takenEmail = await User.findOne({
        email,
        _id: { $ne: user._id },
      }).select("_id");
      if (!takenEmail) user.email = email;
    }
    if (req.body.phone !== undefined && String(req.body.phone).trim()) {
      const phone = normalizePhone(req.body.phone);
      if (/^[6-9]\d{9}$/.test(phone)) {
        const takenPhone = await User.findOne({
          phone,
          _id: { $ne: user._id },
        }).select("_id");
        if (!takenPhone) user.phone = phone;
      }
    }
    if (req.body.address !== undefined) {
      user.address = req.body.address;
    }
    if (req.body.bio !== undefined) {
      user.bio = req.body.bio;
    }

    let updatedUser;
    try {
      updatedUser = await user.save();
    } catch (saveErr) {
      if (saveErr?.code === 11000) {
        const field = Object.keys(saveErr.keyPattern || {})[0] || "field";
        return res.status(409).json({
          status: "fail",
          success: false,
          message:
            field === "phone"
              ? "This mobile number is already used on another account."
              : field === "email"
                ? "This email is already used on another account."
                : "That value is already in use.",
        });
      }
      if (saveErr?.name === "ValidationError") {
        return res.status(400).json({
          status: "fail",
          success: false,
          message: saveErr.message || "Invalid profile details",
        });
      }
      throw saveErr;
    }
    const token = generateToken(updatedUser);
    res.status(200).json({
      status: "success",
      message: "Successfully updated profile",
      data: {
        user: publicUser(updatedUser),
        token,
      },
    });
  } catch (error) {
    next(error);
  }
};

// signUpWithProvider (legacy) — verify Google ID token; do not trust jwt.decode
exports.signUpWithProvider = async (req, res, next) => {
  try {
    const {
      verifyGoogleIdToken,
      findOrLinkGoogleUser,
    } = require("../services/google-auth.service");
    const { issueSession } = require("../services/session.service");

    const credential = req.params.token || req.body?.credential;
    const claims = await verifyGoogleIdToken(credential);
    const { user, created, linked } = await findOrLinkGoogleUser(claims);

    if (created) {
      trackCustomerActivity(user._id, "registration", {
        source: "google",
      }).catch(() => {});
    }
    trackCustomerActivity(user._id, "login", {
      source: linked ? "google_link" : "google",
    }).catch(() => {});

    const session = await issueSession(req, res, user);
    res.status(200).send({
      status: "success",
      success: true,
      data: {
        token: session.accessToken,
        expiresIn: session.expiresIn,
        user: session.user,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: "fail",
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    next(error);
  }
};
