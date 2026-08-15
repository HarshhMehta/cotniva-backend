require("dotenv").config();
const jwt = require("jsonwebtoken");
const Admin = require("../model/Admin");
const { secret } = require("./secret");

const signInToken = (user) => {
  return jwt.sign(
    {
      _id: user._id,
      name: user.name,
      email: user.email,
      address: user.address,
      phone: user.phone,
      image: user.image,
    },
    secret.token_secret,
    {
      expiresIn: "2d",
    }
  );
};

const tokenForVerify = (user) => {
  return jwt.sign(
    {
      _id: user._id,
      name: user.name,
      email: user.email,
      password: user.password,
    },
    secret.jwt_secret_for_verify,
    { expiresIn: "10m" }
  );
};

const ADMIN_ROLES = new Set(["Admin", "Super Admin", "Manager", "CEO"]);

const isAuth = async (req, res, next) => {
  const { authorization } = req.headers;
  try {
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, secret.token_secret);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).send({
      message: err.message,
    });
  }
};

/**
 * Legacy helper — prefer requireAdmin for mutation routes.
 * Only passes if an Admin document exists in the database (not the caller).
 */
const isAdmin = async (req, res, next) => {
  const admin = await Admin.findOne({ role: "Admin" });
  if (admin) {
    next();
  } else {
    res.status(401).send({
      message: "User is not Admin",
    });
  }
};

/**
 * Require a valid JWT whose subject exists in the Admin collection.
 * Customer/user JWTs (same TOKEN_SECRET) receive 403.
 */
const requireAdmin = async (req, res, next) => {
  const { authorization } = req.headers;
  try {
    if (!authorization || !String(authorization).startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }
    const token = String(authorization).split(" ")[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const decoded = jwt.verify(token, secret.token_secret);
    if (!decoded?._id) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    const admin = await Admin.findById(decoded._id).select(
      "_id name email role status"
    );
    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }
    if (admin.status && String(admin.status) !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Admin account is inactive",
      });
    }
    if (admin.role && !ADMIN_ROLES.has(admin.role)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    req.user = {
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    };
    req.admin = admin;
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: err.message || "Unauthorized",
    });
  }
};

module.exports = {
  signInToken,
  tokenForVerify,
  isAuth,
  isAdmin,
  requireAdmin,
  ADMIN_ROLES,
};
