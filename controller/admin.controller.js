const bcrypt = require("bcryptjs");
const Admin = require("../model/Admin");
const { sendEmail } = require("../config/email");
const { secret } = require("../config/secret");
const {
  createPasswordResetFields,
  findByPasswordResetToken,
  clearPasswordResetFields,
} = require("../utils/password-reset-token");
const {
  issueAdminSession,
  publicAdmin,
  clearAdminSessionCookies,
  readAdminRefreshFromRequest,
  revokeAdminRefresh,
  revokeAllAdminSessions,
  rotateAdminRefreshSession,
} = require("../services/admin-session.service");
const {
  verifyBootstrapSecret,
  claimBootstrapAndCreateAdmin,
  getBootstrapStatus,
  isBootstrapped,
} = require("../services/admin-bootstrap.service");

const registerAdmin = async (req, res, next) => {
  try {
    if (await isBootstrapped()) {
      return res.status(403).send({
        message:
          "Admin registration is disabled. Contact an existing administrator.",
      });
    }

    verifyBootstrapSecret(req.body.bootstrapSecret);

    const staff = await claimBootstrapAndCreateAdmin({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: req.body.role || "Admin",
    });

    const session = await issueAdminSession(req, res, staff);
    return res.status(200).send({
      success: true,
      user: session.user,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).send({ message: err.message });
    }
    return next(err);
  }
};

const loginAdmin = async (req, res, next) => {
  try {
    const admin = await Admin.findOne({ email: req.body.email });
    if (admin && bcrypt.compareSync(req.body.password, admin.password)) {
      if (admin.status && String(admin.status) !== "Active") {
        return res.status(403).send({
          message: "Admin account is inactive",
        });
      }
      const session = await issueAdminSession(req, res, admin);
      return res.send({
        success: true,
        user: session.user,
      });
    }
    return res.status(401).send({
      message: "Invalid Email or password!",
    });
  } catch (err) {
    return next(err);
  }
};

const logoutAdmin = async (req, res, next) => {
  try {
    const raw = readAdminRefreshFromRequest(req);
    await revokeAdminRefresh(raw);
    clearAdminSessionCookies(res, req);
    return res.status(200).json({ success: true, message: "Logged out" });
  } catch (err) {
    return next(err);
  }
};

const meAdmin = async (req, res) => {
  return res.status(200).json({
    success: true,
    user: publicAdmin(req.admin),
  });
};

const refreshAdminSession = async (req, res, next) => {
  try {
    const raw = readAdminRefreshFromRequest(req);
    if (!raw) {
      clearAdminSessionCookies(res, req);
      return res.status(401).json({ message: "Authentication required" });
    }
    const session = await rotateAdminRefreshSession(req, res, raw);
    return res.json({ success: true, user: session.user });
  } catch (err) {
    clearAdminSessionCookies(res, req);
    return res.status(err.statusCode || 401).json({
      message: err.message || "Unauthorized",
    });
  }
};

const bootstrapStatus = async (req, res, next) => {
  try {
    const status = await getBootstrapStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return next(err);
  }
};

const forgetPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(404).send({
        message: "Admin Not found with this email!",
      });
    }

    const reset = createPasswordResetFields();
    admin.passwordResetToken = reset.passwordResetToken;
    admin.passwordResetExpires = reset.passwordResetExpires;
    admin.confirmationToken = undefined;
    admin.confirmationTokenExpires = undefined;
    await admin.save({ validateBeforeSave: false });

    const body = {
      from: secret.email_user,
      to: `${email}`,
      subject: "Password Reset",
      html: `<h2>Hello ${email}</h2>
        <p>A request has been received to change the password for your <strong>Cotniva</strong> admin account.</p>
        <p>This link will expire in <strong>10 minutes</strong>.</p>
        <p style="margin-bottom:20px;">Click this link to reset your password</p>
        <a href=${secret.admin_url}/forget-password/${reset.rawToken} style="background:#4a1f1a;color:white;border:1px solid #4a1f1a;padding:10px 15px;border-radius:4px;text-decoration:none;">Reset Password</a>
        <p style="margin-top:35px;">If you did not initiate this request, contact support immediately.</p>`,
    };

    const message = "Please check your email to reset password!";
    return sendEmail(body, res, message);
  } catch (error) {
    return next(error);
  }
};

const confirmAdminForgetPass = async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!password || String(password).length < 6) {
      return res.status(400).json({
        status: "fail",
        message: "Password must be at least 6 characters",
      });
    }

    const admin = await findByPasswordResetToken(Admin, token);
    if (!admin) {
      return res.status(403).json({
        status: "fail",
        message: "Invalid or expired token",
      });
    }

    admin.password = bcrypt.hashSync(password);
    clearPasswordResetFields(admin);
    await admin.save({ validateBeforeSave: false });
    await revokeAllAdminSessions(admin._id);

    return res.status(200).json({
      message: "Password reset successfully",
    });
  } catch (error) {
    return next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const email = req.admin?.email || req.user?.email;
    const { oldPass, newPass } = req.body || {};
    if (!email) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!newPass || String(newPass).length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters",
      });
    }
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }
    if (!bcrypt.compareSync(oldPass, admin.password)) {
      return res.status(401).json({ message: "Incorrect current password" });
    }
    admin.password = bcrypt.hashSync(newPass);
    clearPasswordResetFields(admin);
    await admin.save({ validateBeforeSave: false });
    await revokeAllAdminSessions(admin._id);
    clearAdminSessionCookies(res, req);
    return res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    return next(error);
  }
};

const addStaff = async (req, res, next) => {
  try {
    const isAdded = await Admin.findOne({ email: req.body.email });
    if (isAdded) {
      return res.status(500).send({
        message: "This Email already Added!",
      });
    }
    const newStaff = new Admin({
      name: req.body.name,
      email: req.body.email,
      password: bcrypt.hashSync(req.body.password),
      phone: req.body.phone,
      joiningDate: req.body.joiningDate,
      role: req.body.role,
      image: req.body.image,
    });
    await newStaff.save();
    return res.status(200).send({
      message: "Staff Added Successfully!",
    });
  } catch (err) {
    return next(err);
  }
};

const getAllStaff = async (req, res, next) => {
  try {
    const admins = await Admin.find({})
      .select("-password -passwordResetToken -confirmationToken")
      .sort({ _id: -1 });
    return res.status(200).json({
      status: true,
      message: "Staff get successfully",
      data: admins,
    });
  } catch (err) {
    return next(err);
  }
};

const getStaffById = async (req, res, next) => {
  try {
    const admin = await Admin.findById(req.params.id).select(
      "-password -passwordResetToken -confirmationToken"
    );
    return res.send(admin);
  } catch (err) {
    return next(err);
  }
};

const updateStaff = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id });
    if (!admin) {
      return res.status(404).send({
        message: "This Staff not found!",
      });
    }
    admin.name = req.body.name;
    admin.email = req.body.email;
    admin.phone = req.body.phone;
    admin.role = req.body.role;
    admin.joiningData = req.body.joiningDate;
    admin.image = req.body.image;
    if (req.body.password !== undefined) {
      admin.password = bcrypt.hashSync(req.body.password);
      await revokeAllAdminSessions(admin._id);
    }
    const updatedAdmin = await admin.save();
    return res.send({
      success: true,
      user: publicAdmin(updatedAdmin),
    });
  } catch (err) {
    return res.status(500).send({
      message: err.message,
    });
  }
};

const deleteStaff = async (req, res, next) => {
  try {
    await Admin.findByIdAndDelete(req.params.id);
    return res.status(200).json({
      message: "Admin Deleted Successfully",
    });
  } catch (err) {
    return next(err);
  }
};

const updatedStatus = async (req, res) => {
  try {
    const newStatus = req.body.status;
    await Admin.updateOne(
      { _id: req.params.id },
      { $set: { status: newStatus } }
    );
    return res.send({
      message: `Store ${newStatus} Successfully!`,
    });
  } catch (err) {
    return res.status(500).send({
      message: err.message,
    });
  }
};

module.exports = {
  registerAdmin,
  loginAdmin,
  logoutAdmin,
  meAdmin,
  refreshAdminSession,
  bootstrapStatus,
  forgetPassword,
  addStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
  updatedStatus,
  changePassword,
  confirmAdminForgetPass,
};
