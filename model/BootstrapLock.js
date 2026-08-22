const mongoose = require("mongoose");

/** Singleton — atomic first-admin bootstrap gate */
const bootstrapLockSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  bootstrapped: { type: Boolean, default: false },
  bootstrappedAt: { type: Date },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
});

module.exports = mongoose.model("BootstrapLock", bootstrapLockSchema);
