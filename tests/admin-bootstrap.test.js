#!/usr/bin/env node
/**
 * Admin bootstrap — secret verification (always) + Mongo lock concurrency (when available).
 */
const assert = require("assert");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const BootstrapLock = require("../model/BootstrapLock");
const { secret } = require("../config/secret");
const {
  verifyBootstrapSecret,
  LOCK_ID,
} = require("../services/admin-bootstrap.service");

secret.admin_bootstrap_secret = "test-bootstrap-secret-min-16-chars";
verifyBootstrapSecret("test-bootstrap-secret-min-16-chars");

try {
  verifyBootstrapSecret("wrong-secret-value!!");
  assert.fail("expected invalid bootstrap secret to throw");
} catch (err) {
  assert.strictEqual(err.statusCode, 403);
}

async function testConcurrentLock() {
  if (!process.env.MONGO_URI) {
    console.log("admin-bootstrap lock: skipped (MONGO_URI not set)");
    return;
  }

  await connectDB();
  await BootstrapLock.deleteOne({ _id: LOCK_ID });

  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      BootstrapLock.findOneAndUpdate(
        { _id: LOCK_ID, bootstrapped: { $ne: true } },
        {
          $setOnInsert: { _id: LOCK_ID },
          $set: { bootstrapped: true, bootstrappedAt: new Date() },
        },
        { upsert: true, new: true }
      )
    )
  );

  const winners = attempts.filter(
    (a) => a.status === "fulfilled" && a.value
  );
  assert.strictEqual(
    winners.length,
    1,
    "exactly one concurrent bootstrap lock claim should succeed"
  );

  const lock = await BootstrapLock.findById(LOCK_ID);
  assert.ok(lock?.bootstrapped);

  await BootstrapLock.deleteOne({ _id: LOCK_ID });
  console.log("admin-bootstrap lock concurrency: ok");
}

testConcurrentLock()
  .catch((err) => {
    const msg = String(err?.message || err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("buffering timed out") ||
      msg.includes("connection failed")
    ) {
      console.log("admin-bootstrap lock: skipped (Mongo unavailable)");
      return;
    }
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });

console.log("admin-bootstrap secret verification: ok");
