const jwt = require("jsonwebtoken");
const { promisify } = require("util");
const { secret } = require("../config/secret");
const { readAccessFromRequest } = require("../services/session.service");

/**
 * Accept Bearer header OR HttpOnly access cookie.
 */
module.exports = async (req, res, next) => {
  try {
    const token = readAccessFromRequest(req);

    if (!token) {
      return res.status(401).json({
        status: "fail",
        success: false,
        error: "You are not logged in",
        message: "You are not logged in",
      });
    }

    const decoded = await promisify(jwt.verify)(token, secret.token_secret);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      status: "fail",
      success: false,
      error: "Invalid or expired token",
      message: "Invalid or expired token",
      code: "TOKEN_EXPIRED",
    });
  }
};
