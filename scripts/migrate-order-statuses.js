/**
 * One-time / safe re-runnable migration for Cotniva order lifecycle.
 *
 * Usage: node scripts/migrate-order-statuses.js
 *
 * - Maps legacy pending → confirmed ONLY when reliable payment evidence exists
 * - Sets paymentStatus=paid ONLY from reliable evidence (never from paymentMethod alone)
 * - Maps cancel → cancelled
 * - Stamps emailsSent for past states so no historical emails fire
 * - Does NOT trigger refunds, emails, inventory changes, or Razorpay API calls
 *
 * Reliable payment evidence:
 *   - paymentStatus already paid|refunded, OR
 *   - non-empty paymentIntent.razorpay_payment_id
 *   - (refunded) cancellation/refund id evidence for refunded status
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { secret } = require("../config/secret");
const Order = require("../model/Order");

const stampEmailsForStatus = (status) => {
  const now = new Date();
  const emailsSent = {
    confirmed: now,
    admin_new_order: now,
  };
  const s = String(status || "").toLowerCase();
  if (["shipped", "out_for_delivery", "delivered"].includes(s)) {
    emailsSent.shipped = now;
  }
  if (["out_for_delivery", "delivered"].includes(s)) {
    emailsSent.out_for_delivery = now;
  }
  if (s === "delivered") {
    emailsSent.delivered = now;
  }
  if (["cancel", "cancelled"].includes(s)) {
    emailsSent.cancelled = now;
    emailsSent.admin_cancelled = now;
  }
  return emailsSent;
};

/** Non-empty Razorpay payment id stored on the order */
const hasStoredPaymentId = (order) => {
  const id = order?.paymentIntent?.razorpay_payment_id;
  return Boolean(id && String(id).trim());
};

/**
 * Reliable evidence of successful payment — does NOT use paymentMethod string alone.
 */
const hasReliablePaidEvidence = (order) => {
  const ps = String(order.paymentStatus || "").toLowerCase();
  if (ps === "paid" || ps === "refunded") return true;
  if (hasStoredPaymentId(order)) return true;
  return false;
};

const hasReliableRefundedEvidence = (order) => {
  const ps = String(order.paymentStatus || "").toLowerCase();
  if (ps === "refunded") return true;
  if (order?.refund?.razorpayRefundId && String(order.refund.razorpayRefundId).trim()) {
    return true;
  }
  return false;
};

async function run() {
  const uri = secret.db_url || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  await mongoose.connect(uri);
  console.log("Connected");

  // lean() avoids Mongoose schema defaults masking missing paymentStatus
  const orders = await Order.find({}).lean();
  let updated = 0;
  let skipped = 0;

  for (const order of orders) {
    const prevStatus = String(order.status || "pending").toLowerCase();
    const prevPayment = order.paymentStatus
      ? String(order.paymentStatus).toLowerCase()
      : null;
    const set = {};
    let changed = false;

    // --- paymentStatus (evidence-based only) ---
    if (hasReliableRefundedEvidence(order) && prevPayment !== "refunded") {
      set.paymentStatus = "refunded";
      changed = true;
    } else if (
      hasReliablePaidEvidence(order) &&
      prevPayment !== "paid" &&
      prevPayment !== "refunded" &&
      !hasReliableRefundedEvidence(order)
    ) {
      // Has razorpay_payment_id (or already paid) → set paid when not already terminal
      if (prevPayment !== "paid") {
        set.paymentStatus = "paid";
        changed = true;
      }
    } else if (prevPayment == null) {
      // Field missing in DB — leave as pending only when no payment evidence
      if (!hasReliablePaidEvidence(order) && !hasReliableRefundedEvidence(order)) {
        set.paymentStatus = "pending";
        changed = true;
      }
    }
    // If paymentStatus is already pending/failed with no payment id → leave unchanged

    // --- fulfillment status mapping ---
    if (prevStatus === "pending" && hasReliablePaidEvidence(order)) {
      set.status = "confirmed";
      changed = true;
    } else if (prevStatus === "cancel") {
      set.status = "cancelled";
      changed = true;
    }
    // Do NOT promote pending→confirmed from paymentMethod alone

    // --- refund default ---
    if (!order.refund?.status) {
      set["refund.status"] = hasReliableRefundedEvidence(order)
        ? "initiated"
        : "not_required";
      changed = true;
    }

    // --- emailsSent — never send historical ---
    if (!order.emailsSent || !order.emailsSent.confirmed) {
      const finalStatus = set.status || prevStatus;
      Object.entries(stampEmailsForStatus(finalStatus)).forEach(([k, v]) => {
        set[`emailsSent.${k}`] = v;
      });
      changed = true;
    }

    // --- history seed if empty ---
    if (!order.statusHistory?.length) {
      const finalStatus = set.status || prevStatus;
      set.statusHistory = [
        {
          from: null,
          to: finalStatus === "pending" ? "confirmed" : finalStatus,
          at: order.createdAt || new Date(),
          source: "migration",
          note: "Migrated from legacy order statuses",
        },
      ];
      changed = true;
    }

    if (changed) {
      await Order.updateOne({ _id: order._id }, { $set: set });
      updated += 1;
      console.log(
        `Migrated #${order.invoice || order._id}: ${prevStatus} → ${
          set.status || prevStatus
        }, payment=${set.paymentStatus || prevPayment || "unchanged"}`
      );
    } else {
      skipped += 1;
    }
  }

  console.log(
    `Done. Updated ${updated}/${orders.length} orders (${skipped} already up to date).`
  );
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
