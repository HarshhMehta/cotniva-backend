const Order = require("../model/Order");
const { sendMailAsync } = require("../config/email");
const { secret } = require("../config/secret");

const BRAND = "Cotniva";
const THEME = "#4a1f1a";

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const isPlaceholderEmail = (email) => {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return true;
  return (
    e.endsWith("@phone.cotniva.local") ||
    e.endsWith("@cotniva.local") ||
    e.includes("noreply")
  );
};

const adminInbox = () =>
  String(secret.admin_order_email || secret.email_user || "").trim();

/**
 * Atomically begin an email send (short-lived lock).
 * Returns true only if this caller may send.
 * Does NOT mark the email as permanently sent.
 */
const EMAIL_SEND_LOCK_MS = Math.max(
  60 * 1000,
  Number(process.env.EMAIL_SEND_LOCK_MS) || 5 * 60 * 1000
);

const beginEmailSend = async (orderId, key) => {
  if (!orderId || !key) return false;
  const sentField = `emailsSent.${key}`;
  const lockField = `emailsSending.${key}`;
  const staleBefore = new Date(Date.now() - EMAIL_SEND_LOCK_MS);

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      $and: [
        {
          $or: [{ [sentField]: { $exists: false } }, { [sentField]: null }],
        },
        {
          $or: [
            { [lockField]: { $exists: false } },
            { [lockField]: null },
            { [lockField]: { $lt: staleBefore } },
          ],
        },
      ],
    },
    { $set: { [lockField]: new Date() } },
    { new: true }
  );
  return Boolean(updated);
};

/** Mark email as successfully sent and clear the send lock. */
const completeEmailSend = async (orderId, key) => {
  if (!orderId || !key) return;
  const sentField = `emailsSent.${key}`;
  const lockField = `emailsSending.${key}`;
  await Order.updateOne(
    { _id: orderId },
    {
      $set: { [sentField]: new Date() },
      $unset: { [lockField]: 1 },
    }
  );
};

/** Release send lock after failure so the email remains retryable. */
const failEmailSend = async (orderId, key) => {
  if (!orderId || !key) return;
  const lockField = `emailsSending.${key}`;
  await Order.updateOne({ _id: orderId }, { $unset: { [lockField]: 1 } });
};

/**
 * Backward-compatible name: permanently claim a sent slot (migration / stamp helpers).
 * Prefer begin/complete/fail for live sends.
 */
const claimEmailSlot = async (orderId, key) => {
  if (!orderId || !key) return false;
  const field = `emailsSent.${key}`;
  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      $or: [{ [field]: { $exists: false } }, { [field]: null }],
    },
    { $set: { [field]: new Date() } },
    { new: true }
  );
  return Boolean(updated);
};

const cartRows = (cart = []) =>
  (cart || [])
    .map((item) => {
      const title = esc(item.title || item.name || "Item");
      const size = item.selectedSize ? ` · Size ${esc(item.selectedSize)}` : "";
      const qty = Number(item.orderQuantity || item.quantity || 1);
      const price = Number(item.price || 0);
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #eee;color:#222;">${title}${size}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:center;color:#555;">${qty}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;color:#222;">${inr(
          price * qty
        )}</td>
      </tr>`;
    })
    .join("");

const layout = ({ title, preheader, bodyHtml }) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#f6f5f4;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f4;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:${THEME};padding:18px 24px;">
            <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:0.04em;">${BRAND}</div>
            <div style="color:#f3e8e6;font-size:13px;margin-top:4px;">${esc(title)}</div>
          </td>
        </tr>
        <tr><td style="padding:24px;">${bodyHtml}</td></tr>
        <tr>
          <td style="padding:16px 24px 22px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.5;">
            Need help? Reply to this email or write to ${esc(secret.email_user || "support")}.
            <br/>© ${new Date().getFullYear()} ${BRAND}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const orderSummaryBlock = (order = {}) => {
  const addressBits = [order.address, order.city, order.zipCode, order.country]
    .filter(Boolean)
    .map(esc)
    .join(", ");

  return `
    <p style="margin:0 0 12px;color:#555;font-size:14px;line-height:1.6;">
      <strong style="color:#111;">Invoice:</strong> #${esc(order.invoice || "—")}<br/>
      <strong style="color:#111;">Customer:</strong> ${esc(order.name || "—")}<br/>
      <strong style="color:#111;">Phone:</strong> ${esc(order.contact || "—")}<br/>
      <strong style="color:#111;">Email:</strong> ${esc(order.email || "—")}<br/>
      <strong style="color:#111;">Payment:</strong> ${esc(order.paymentMethod || "—")} · ${esc(order.paymentStatus || "—")}<br/>
      <strong style="color:#111;">Status:</strong> ${esc(order.status || "—")}<br/>
      <strong style="color:#111;">Ship to:</strong> ${addressBits || "—"}
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;font-size:14px;">
      <thead>
        <tr>
          <th align="left" style="padding:8px 0;border-bottom:2px solid ${THEME};color:${THEME};">Item</th>
          <th align="center" style="padding:8px 0;border-bottom:2px solid ${THEME};color:${THEME};">Qty</th>
          <th align="right" style="padding:8px 0;border-bottom:2px solid ${THEME};color:${THEME};">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${cartRows(order.cart) || `<tr><td colspan="3" style="padding:12px 0;color:#888;">No items</td></tr>`}
      </tbody>
    </table>
    <table role="presentation" width="100%" style="font-size:14px;color:#333;">
      <tr><td style="padding:4px 0;">Subtotal</td><td align="right">${inr(order.subTotal)}</td></tr>
      <tr><td style="padding:4px 0;">Shipping</td><td align="right">${inr(order.shippingCost)}</td></tr>
      <tr><td style="padding:4px 0;">Discount</td><td align="right">-${inr(order.discount)}</td></tr>
      <tr>
        <td style="padding:10px 0 0;font-weight:700;font-size:16px;color:${THEME};">Total</td>
        <td align="right" style="padding:10px 0 0;font-weight:700;font-size:16px;color:${THEME};">${inr(
          order.totalAmount
        )}</td>
      </tr>
    </table>
  `;
};

const sendSafe = async (label, mail) => {
  try {
    const info = await sendMailAsync(mail);
    console.log(`[order-email] ${label} → ${mail.to} (${info.messageId || "ok"})`);
    return info;
  } catch (err) {
    console.error(`[order-email] ${label} failed:`, err.message);
    return null;
  }
};

/** Throws on failure so lifecycle email locks can release and retry. */
const sendOrThrow = async (label, mail) => {
  const info = await sendMailAsync(mail);
  console.log(`[order-email] ${label} → ${mail.to} (${info.messageId || "ok"})`);
  return info;
};

const storeUrl = () => secret.client_url || "https://cotniva.vercel.app";
const adminUrl = () => secret.admin_url || "";

const sendOrderConfirmedEmails = async (order) => {
  if (!order) return;
  const invoice = order.invoice != null ? `#${order.invoice}` : "";

  const customerHtml = layout({
    title: "Order confirmed",
    preheader: `Your Cotniva order ${invoice} is confirmed`,
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:18px;color:#111;font-weight:700;">Thank you, ${esc(
        order.name || "there"
      )}!</p>
      <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.6;">
        Your payment was successful and your order ${esc(invoice)} is confirmed. We’ll start preparing it shortly.
      </p>
      ${orderSummaryBlock(order)}
      <p style="margin:22px 0 0;">
        <a href="${esc(storeUrl())}/order/${esc(String(order._id || ""))}"
           style="display:inline-block;background:${THEME};color:#fff;text-decoration:none;padding:11px 18px;border-radius:6px;font-size:14px;">
          View order
        </a>
      </p>
    `,
  });

  const adminHtml = layout({
    title: "New order received",
    preheader: `New Cotniva order ${invoice} · ${inr(order.totalAmount)}`,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:16px;color:#111;font-weight:700;">
        New paid order ${esc(invoice)} (confirmed)
      </p>
      ${orderSummaryBlock(order)}
      ${
        order._id && adminUrl()
          ? `<p style="margin:22px 0 0;"><a href="${esc(
              adminUrl()
            )}/orders" style="color:${THEME};">Open admin orders</a></p>`
          : ""
      }
    `,
  });

  const jobs = [];
  if (!isPlaceholderEmail(order.email)) {
    jobs.push({
      label: "customer-confirm",
      mail: {
        to: order.email,
        subject: `Order confirmed ${invoice} · ${BRAND}`,
        html: customerHtml,
      },
    });
  } else {
    console.warn(
      `[order-email] customer-confirm skipped placeholder email=${order.email}`
    );
  }
  const adminTo = adminInbox();
  if (adminTo) {
    jobs.push({
      label: "admin-new-order",
      mail: {
        to: adminTo,
        subject: `New order ${invoice} · ${inr(order.totalAmount)} · ${BRAND}`,
        html: adminHtml,
      },
    });
  } else {
    console.warn("[order-email] admin-new-order skipped (ADMIN_ORDER_EMAIL empty)");
  }
  if (!jobs.length) {
    console.warn("[order-email] confirmed: no recipients");
    return;
  }
  // Sequential: Render/Gmail often time out if two SMTP connections open at once
  const errors = [];
  for (const job of jobs) {
    try {
      await sendOrThrow(job.label, job.mail);
    } catch (err) {
      console.error(`[order-email] ${job.label} failed:`, err.message);
      errors.push(err);
    }
  }
  if (errors.length === jobs.length) {
    throw errors[0] || new Error("All confirmation emails failed");
  }
  if (errors.length) {
    console.error(
      "[order-email] confirmed partial failure:",
      errors.map((e) => e.message).join("; ")
    );
  }
};

const sendOrderFailedEmails = async ({
  email,
  name,
  reason,
  amount,
  invoice,
  paymentMethod,
  meta = {},
} = {}) => {
  const reasonText = reason || "Your payment could not be completed.";
  const amountText = amount != null ? inr(amount) : "";

  const customerHtml = layout({
    title: "Order / payment failed",
    preheader: "Your Cotniva payment did not go through",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:18px;color:#111;font-weight:700;">
        Hi ${esc(name || "there")},
      </p>
      <p style="margin:0 0 14px;color:#555;font-size:14px;line-height:1.6;">
        We couldn’t complete your order${
          amountText ? ` for <strong>${amountText}</strong>` : ""
        }.
      </p>
      <p style="margin:0 0 14px;padding:12px;background:#fff5f5;border-radius:8px;color:#9b1c1c;font-size:14px;">
        ${esc(reasonText)}
      </p>
      <p style="margin:0;color:#555;font-size:14px;line-height:1.6;">
        You can try again from your cart. If money was deducted, it will be refunded as per Razorpay timelines.
      </p>
    `,
  });

  const adminHtml = layout({
    title: "Payment failed",
    preheader: `Failed checkout · ${amountText || "Cotniva"}`,
    bodyHtml: `
      <p style="margin:0 0 12px;font-size:16px;color:#111;font-weight:700;">A checkout payment failed</p>
      <p style="margin:0;color:#555;font-size:14px;line-height:1.7;">
        <strong>Customer:</strong> ${esc(name || "—")}<br/>
        <strong>Email:</strong> ${esc(email || "—")}<br/>
        <strong>Amount:</strong> ${esc(amountText || "—")}<br/>
        <strong>Invoice:</strong> ${esc(invoice || "—")}<br/>
        <strong>Method:</strong> ${esc(paymentMethod || "Razorpay")}<br/>
        <strong>Reason:</strong> ${esc(reasonText)}<br/>
        <strong>Razorpay order:</strong> ${esc(meta.razorpay_order_id || "—")}<br/>
        <strong>Razorpay payment:</strong> ${esc(meta.razorpay_payment_id || "—")}
      </p>
    `,
  });

  const jobs = [];
  if (!isPlaceholderEmail(email)) {
    jobs.push(
      sendSafe("customer-failed", {
        to: email,
        subject: `Payment failed · ${BRAND}`,
        html: customerHtml,
      })
    );
  }
  const adminTo = adminInbox();
  if (adminTo) {
    jobs.push(
      sendSafe("admin-failed", {
        to: adminTo,
        subject: `Payment failed${amountText ? ` · ${amountText}` : ""} · ${BRAND}`,
        html: adminHtml,
      })
    );
  }
  await Promise.all(jobs);
};

const sendOrderShippedEmail = async (order) => {
  if (!order || isPlaceholderEmail(order.email)) return;
  const invoice = order.invoice != null ? `#${order.invoice}` : "";
  const tracking =
    order.trackingNumber || order.trackingUrl
      ? `<p style="margin:14px 0;padding:12px;background:#f6f5f4;border-radius:8px;font-size:14px;color:#333;">
          ${
            order.trackingNumber
              ? `<strong>Tracking:</strong> ${esc(order.trackingNumber)}<br/>`
              : ""
          }
          ${
            order.trackingUrl
              ? `<a href="${esc(order.trackingUrl)}" style="color:${THEME};">Track shipment</a>`
              : ""
          }
        </p>`
      : `<p style="margin:14px 0;color:#555;font-size:14px;">Tracking details will be shared when available.</p>`;

  await sendOrThrow("customer-shipped", {
    to: order.email,
    subject: `Order shipped ${invoice} · ${BRAND}`,
    html: layout({
      title: "Order shipped",
      preheader: `Your Cotniva order ${invoice} is on the way`,
      bodyHtml: `
        <p style="margin:0 0 8px;font-size:18px;color:#111;font-weight:700;">Your order is on its way</p>
        <p style="margin:0 0 14px;color:#555;font-size:14px;line-height:1.6;">
          Order ${esc(invoice)} has been handed over to the courier.
        </p>
        ${tracking}
        ${orderSummaryBlock(order)}
      `,
    }),
  });
};

const sendOrderOutForDeliveryEmail = async (order) => {
  if (!order || isPlaceholderEmail(order.email)) return;
  const invoice = order.invoice != null ? `#${order.invoice}` : "";
  await sendOrThrow("customer-ofd", {
    to: order.email,
    subject: `Out for delivery ${invoice} · ${BRAND}`,
    html: layout({
      title: "Out for delivery",
      preheader: `Your Cotniva order ${invoice} is out for delivery`,
      bodyHtml: `
        <p style="margin:0 0 8px;font-size:18px;color:#111;font-weight:700;">Almost there</p>
        <p style="margin:0 0 14px;color:#555;font-size:14px;line-height:1.6;">
          Order ${esc(invoice)} is out for delivery today. Please keep your phone handy.
        </p>
        ${orderSummaryBlock(order)}
      `,
    }),
  });
};

const sendOrderDeliveredEmail = async (order) => {
  if (!order || isPlaceholderEmail(order.email)) return;
  const invoice = order.invoice != null ? `#${order.invoice}` : "";
  const reviewUrl = `${storeUrl()}/order/${esc(String(order._id || ""))}#write-review`;
  await sendOrThrow("customer-delivered", {
    to: order.email,
    subject: `Delivered ${invoice} · ${BRAND}`,
    html: layout({
      title: "Order delivered",
      preheader: `Your Cotniva order ${invoice} was delivered — tell us how you liked it`,
      bodyHtml: `
        <p style="margin:0 0 8px;font-size:18px;color:#111;font-weight:700;">Delivered</p>
        <p style="margin:0 0 14px;color:#555;font-size:14px;line-height:1.6;">
          Order ${esc(invoice)} has been marked as delivered. We hope you love it.
        </p>
        ${orderSummaryBlock(order)}
        <div style="margin:22px 0 8px;padding:18px 16px;background:#f7f3ef;border-radius:10px;text-align:center;">
          <p style="margin:0 0 6px;font-size:16px;color:#111;font-weight:700;">
            How did you like your purchase?
          </p>
          <p style="margin:0 0 14px;color:#666;font-size:13px;line-height:1.5;">
            Your feedback helps other shoppers and keeps Cotniva growing.
          </p>
          <a href="${reviewUrl}"
             style="display:inline-block;background:${THEME};color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">
            Write a Review
          </a>
        </div>
      `,
    }),
  });
};

const sendOrderCancelledEmails = async (
  order,
  { reason, refundStatus, refundId, refundError } = {}
) => {
  if (!order) return;
  const invoice = order.invoice != null ? `#${order.invoice}` : "";
  const st = String(refundStatus || order.refund?.status || "").toLowerCase();

  let refundCopy = "";
  if (st === "completed") {
    refundCopy =
      "Your refund has been completed. It may take a few business days to reflect in your account.";
  } else if (st === "initiated") {
    refundCopy =
      "A refund has been initiated with Razorpay. It is not completed yet — funds typically reflect in 5–7 business days.";
  } else if (st === "failed") {
    refundCopy =
      "We cancelled the order, but the automatic refund did not complete. Our team will process it manually — you do not need to take action.";
  } else {
    refundCopy = "Refund status will be updated shortly.";
  }

  const customerHtml = layout({
    title: "Order cancelled",
    preheader: `Your Cotniva order ${invoice} was cancelled`,
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:18px;color:#111;font-weight:700;">Order cancelled</p>
      <p style="margin:0 0 14px;color:#555;font-size:14px;line-height:1.6;">
        Order ${esc(invoice)} has been cancelled by Cotniva.
        ${reason ? `<br/><strong>Reason:</strong> ${esc(reason)}` : ""}
      </p>
      <p style="margin:0 0 14px;padding:12px;background:#f6f5f4;border-radius:8px;color:#333;font-size:14px;">
        <strong>Refund status:</strong> ${esc(st || "pending")}<br/>
        ${esc(refundCopy)}
        ${refundId ? `<br/><strong>Refund ref:</strong> ${esc(refundId)}` : ""}
      </p>
      ${orderSummaryBlock(order)}
    `,
  });

  const adminHtml = layout({
    title: "Emergency cancellation",
    preheader: `Order ${invoice} cancelled`,
    bodyHtml: `
      <p style="margin:0 0 12px;font-size:16px;color:#111;font-weight:700;">Emergency cancel · ${esc(invoice)}</p>
      <p style="margin:0 0 12px;color:#555;font-size:14px;line-height:1.7;">
        <strong>Reason:</strong> ${esc(reason || "—")}<br/>
        <strong>Refund status:</strong> ${esc(st || "—")}<br/>
        <strong>Refund ID:</strong> ${esc(refundId || order.refund?.razorpayRefundId || "—")}<br/>
        ${refundError ? `<strong>Refund error:</strong> ${esc(refundError)}<br/>` : ""}
        <strong>Cancelled by:</strong> ${esc(order.cancellation?.cancelledByEmail || "admin")}
      </p>
      ${orderSummaryBlock(order)}
    `,
  });

  const jobs = [];
  if (!isPlaceholderEmail(order.email)) {
    jobs.push(
      sendOrThrow("customer-cancelled", {
        to: order.email,
        subject: `Order cancelled ${invoice} · ${BRAND}`,
        html: customerHtml,
      })
    );
  }
  const adminTo = adminInbox();
  if (adminTo) {
    jobs.push(
      sendOrThrow("admin-cancelled", {
        to: adminTo,
        subject: `Emergency cancel ${invoice} · ${BRAND}`,
        html: adminHtml,
      })
    );
  }
  await Promise.all(jobs);
};

module.exports = {
  beginEmailSend,
  completeEmailSend,
  failEmailSend,
  claimEmailSlot,
  sendOrderConfirmedEmails,
  sendOrderFailedEmails,
  sendOrderShippedEmail,
  sendOrderOutForDeliveryEmail,
  sendOrderDeliveredEmail,
  sendOrderCancelledEmails,
  isPlaceholderEmail,
};
