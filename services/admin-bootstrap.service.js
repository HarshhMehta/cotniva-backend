const BootstrapLock = require("../model/BootstrapLock");
const Admin = require("../model/Admin");
const { secret } = require("../config/secret");

const LOCK_ID = "cotniva_admin_bootstrap";

const ensureLockSynced = async () => {
  const adminCount = await Admin.countDocuments();
  if (adminCount === 0) return false;

  await BootstrapLock.findOneAndUpdate(
    { _id: LOCK_ID },
    {
      $setOnInsert: { _id: LOCK_ID },
      $set: { bootstrapped: true, bootstrappedAt: new Date() },
    },
    { upsert: true }
  );
  return true;
};

const isBootstrapped = async () => {
  const lock = await BootstrapLock.findById(LOCK_ID);
  if (lock?.bootstrapped) return true;
  return ensureLockSynced();
};

const getBootstrapStatus = async () => {
  const bootstrapped = await isBootstrapped();
  return {
    bootstrapped,
    needsBootstrapSecret: !bootstrapped,
  };
};

const verifyBootstrapSecret = (provided) => {
  const expected = secret.admin_bootstrap_secret;
  if (!expected || String(expected).length < 16) {
    const err = new Error(
      "Admin bootstrap is not configured on the server (ADMIN_BOOTSTRAP_SECRET)"
    );
    err.statusCode = 503;
    throw err;
  }
  const a = String(provided || "");
  const b = String(expected);
  if (a.length !== b.length || !cryptoSafeEqual(a, b)) {
    const err = new Error("Invalid bootstrap secret");
    err.statusCode = 403;
    throw err;
  }
};

const cryptoSafeEqual = (a, b) => {
  const crypto = require("crypto");
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/**
 * Atomically claim bootstrap lock, then create the first admin.
 * Concurrent callers: only one succeeds.
 */
const claimBootstrapAndCreateAdmin = async ({
  name,
  email,
  password,
  role,
}) => {
  if (await isBootstrapped()) {
    const err = new Error("Admin bootstrap already completed");
    err.statusCode = 403;
    throw err;
  }

  const existingEmail = await Admin.findOne({ email });
  if (existingEmail) {
    const err = new Error("This Email already Added!");
    err.statusCode = 403;
    throw err;
  }

  const claimed = await BootstrapLock.findOneAndUpdate(
    { _id: LOCK_ID, bootstrapped: { $ne: true } },
    {
      $setOnInsert: { _id: LOCK_ID },
      $set: { bootstrapped: true, bootstrappedAt: new Date() },
    },
    { upsert: true, new: true }
  );

  if (!claimed || claimed.bootstrapped !== true) {
    const err = new Error("Admin bootstrap already completed");
    err.statusCode = 403;
    throw err;
  }

  const bcrypt = require("bcryptjs");
  try {
    const staff = await Admin.create({
      name,
      email,
      role: role || "Admin",
      password: bcrypt.hashSync(password),
    });

    await BootstrapLock.updateOne(
      { _id: LOCK_ID },
      { $set: { adminId: staff._id } }
    );

    return staff;
  } catch (err) {
    if (err?.code === 11000) {
      const dup = new Error("Admin bootstrap already completed");
      dup.statusCode = 403;
      throw dup;
    }
    const count = await Admin.countDocuments();
    if (count === 0) {
      await BootstrapLock.updateOne(
        { _id: LOCK_ID },
        {
          $set: { bootstrapped: false },
          $unset: { bootstrappedAt: 1, adminId: 1 },
        }
      );
    }
    throw err;
  }
};

module.exports = {
  LOCK_ID,
  isBootstrapped,
  getBootstrapStatus,
  verifyBootstrapSecret,
  claimBootstrapAndCreateAdmin,
};
