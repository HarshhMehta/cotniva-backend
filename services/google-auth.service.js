const { OAuth2Client } = require("google-auth-library");
const User = require("../model/User");
const { secret } = require("../config/secret");

let client = null;

const getClient = () => {
  const audience = String(secret.google_client_id || "").trim();
  if (!audience) {
    const err = new Error("Google sign-in is not configured");
    err.statusCode = 503;
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }
  if (!client) {
    client = new OAuth2Client(audience);
  }
  return { client, audience };
};

const pickDisplayName = (payload = {}) => {
  const candidates = [
    payload.name,
    `${payload.given_name || ""} ${payload.family_name || ""}`.trim(),
    payload.email ? String(payload.email).split("@")[0] : "",
    "Cotniva Customer",
  ];
  for (const raw of candidates) {
    const name = String(raw || "").trim();
    if (name.length >= 3) return name.slice(0, 100);
  }
  return "Cotniva Customer";
};

/**
 * Verify Google ID token (GIS credential) and return payload claims.
 */
const verifyGoogleIdToken = async (credential) => {
  const token = String(credential || "").trim();
  if (!token) {
    const err = new Error("Missing Google credential");
    err.statusCode = 400;
    err.code = "MISSING_CREDENTIAL";
    throw err;
  }

  const { client, audience } = getClient();

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: token,
      audience,
    });
  } catch (e) {
    const err = new Error("Invalid or expired Google credential");
    err.statusCode = 401;
    err.code = "INVALID_GOOGLE_TOKEN";
    throw err;
  }

  const payload = ticket.getPayload() || {};
  const iss = String(payload.iss || "");
  if (
    iss !== "https://accounts.google.com" &&
    iss !== "accounts.google.com"
  ) {
    const err = new Error("Invalid Google token issuer");
    err.statusCode = 401;
    err.code = "INVALID_ISSUER";
    throw err;
  }

  if (!payload.sub) {
    const err = new Error("Google token missing subject");
    err.statusCode = 401;
    err.code = "MISSING_SUB";
    throw err;
  }

  if (!payload.email) {
    const err = new Error("Google account has no email");
    err.statusCode = 400;
    err.code = "MISSING_EMAIL";
    throw err;
  }

  if (payload.email_verified !== true && payload.email_verified !== "true") {
    const err = new Error("Google email is not verified");
    err.statusCode = 403;
    err.code = "EMAIL_NOT_VERIFIED";
    throw err;
  }

  return {
    sub: String(payload.sub),
    email: String(payload.email).trim().toLowerCase(),
    email_verified: true,
    name: payload.name || "",
    given_name: payload.given_name || "",
    family_name: payload.family_name || "",
    picture: payload.picture || "",
  };
};

/**
 * Find or create / link Cotniva user from verified Google claims.
 * Never creates a duplicate for the same verified email.
 */
const findOrLinkGoogleUser = async (claims) => {
  const googleId = claims.sub;
  const email = claims.email;

  let user = await User.findOne({ googleId });
  if (user) {
    if (user.status === "blocked") {
      const err = new Error("Your account has been blocked");
      err.statusCode = 403;
      err.code = "ACCOUNT_BLOCKED";
      throw err;
    }
    let dirty = false;
    if (user.status === "inactive") {
      user.status = "active";
      dirty = true;
    }
    if (!user.googleSignIn) {
      user.googleSignIn = true;
      dirty = true;
    }
    if (!user.emailVerified) {
      user.emailVerified = true;
      dirty = true;
    }
    if (dirty) await user.save({ validateBeforeSave: false });
    return { user, created: false, linked: false };
  }

  user = await User.findOne({ email });
  if (user) {
    if (user.status === "blocked") {
      const err = new Error("Your account has been blocked");
      err.statusCode = 403;
      err.code = "ACCOUNT_BLOCKED";
      throw err;
    }
    // Another Google account already linked to this email?
    if (user.googleId && user.googleId !== googleId) {
      const err = new Error(
        "This email is already linked to a different Google account"
      );
      err.statusCode = 409;
      err.code = "GOOGLE_ALREADY_LINKED";
      throw err;
    }

    user.googleId = googleId;
    user.googleSignIn = true;
    user.emailVerified = true;
    if (user.status === "inactive") user.status = "active";
    if (!user.imageURL && claims.picture) user.imageURL = claims.picture;
    // Do NOT overwrite password
    await user.save({ validateBeforeSave: false });
    return { user, created: false, linked: true };
  }

  const displayName = pickDisplayName(claims);
  user = await User.create({
    name: displayName,
    email,
    googleId,
    googleSignIn: true,
    emailVerified: true,
    imageURL: claims.picture || undefined,
    status: "active",
    // password intentionally omitted for Google-only accounts
  });

  return { user, created: true, linked: false };
};

module.exports = {
  verifyGoogleIdToken,
  findOrLinkGoogleUser,
};
