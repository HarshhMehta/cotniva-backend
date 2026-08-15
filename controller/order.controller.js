const crypto = require("crypto");
const Razorpay = require("razorpay");
const { secret } = require("../config/secret");
const Order = require("../model/Order");
const {
  notifyNewOrder,
  notifyPaymentFailed,
} = require("../services/notification.service");
const {
  onOrderConfirmedCreated,
  applyFulfillmentStatus,
  emergencyCancelOrder,
  resendOrderConfirmedNotifications,
  CANCEL_REASONS,
} = require("../services/order-status.service");
const { trackCustomerActivity } = require("../services/customer-activity.service");
const {
  reserveCartStock,
  saveHold,
  getHold,
  commitHold,
  releaseHold,
  restoreReservations,
  attachCommittedHold,
  newReleaseToken,
} = require("../services/inventory.service");
const {
  safeAutoRefundPayment,
  acquirePersistLock,
  releasePersistLock,
  markPaymentAttemptOrderCreated,
  applyRazorpayRefundWebhook,
} = require("../services/razorpay-refund.service");
const StoreSettings = require("../model/StoreSettings");

const STORE_DEFAULTS = {
  deliveryCharge: 100,
  freeShippingAbove: 1299,
};

const getStoreShippingSettings = async () => {
  try {
    const settings = await StoreSettings.findOne().lean();
    return {
      deliveryCharge:
        settings?.deliveryCharge != null
          ? Number(settings.deliveryCharge)
          : STORE_DEFAULTS.deliveryCharge,
      freeShippingAbove:
        settings?.freeShippingAbove != null
          ? Number(settings.freeShippingAbove)
          : STORE_DEFAULTS.freeShippingAbove,
    };
  } catch {
    return { ...STORE_DEFAULTS };
  }
};

const resolveShippingCostRupees = (subTotalRupees, settings) => {
  const charge = Math.max(0, Number(settings?.deliveryCharge) || 0);
  const threshold = Math.max(0, Number(settings?.freeShippingAbove) || 0);
  const total = Math.max(0, Number(subTotalRupees) || 0);
  if (threshold > 0 && total >= threshold) return 0;
  return charge;
};

const getRazorpay = () => {
  if (!secret.razorpay_key_id || !secret.razorpay_key_secret) {
    throw new Error("Razorpay keys are not configured");
  }
  return new Razorpay({
    key_id: secret.razorpay_key_id,
    key_secret: secret.razorpay_key_secret,
  });
};

const toPaise = (amount) => Math.round(Number(amount || 0) * 100);

const isBlank = (v) =>
  v == null ||
  String(v).trim() === "" ||
  ["—", "-", "n/a", "na", "address via razorpay", "pending — sync from razorpay"].includes(
    String(v).trim().toLowerCase()
  );

const pick = (...vals) => {
  for (const v of vals) {
    if (!isBlank(v)) return String(v).trim();
  }
  return "";
};

const formatRazorpayAddress = (addr = {}) =>
  [addr.line1, addr.line2, addr.street, addr.address]
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean)
    .join(", ");

/**
 * Pull shipping fields from Magic Checkout order payload.
 */
const extractShippingFromRzp = (rzpOrder) => {
  if (!rzpOrder) return null;
  const details =
    rzpOrder.customer_details ||
    rzpOrder.customer ||
    null;
  const addr =
    details?.shipping_address ||
    details?.billing_address ||
    rzpOrder.shipping_address ||
    null;
  if (!details && !addr) return null;

  const contact = pick(
    details?.contact,
    addr?.contact,
    rzpOrder?.notes?.contact
  );
  const email = pick(details?.email, rzpOrder?.notes?.email);
  const name = pick(
    [addr?.name, addr?.lastname].filter(Boolean).join(" "),
    addr?.name,
    details?.name,
    rzpOrder?.notes?.name
  );
  const line = formatRazorpayAddress(addr || {});
  const city = pick(addr?.city);
  const state = pick(addr?.state, addr?.state_code);
  const zipCode = pick(addr?.zipcode, addr?.zip_code, addr?.zip);
  const country = pick(addr?.country, "IN").toUpperCase();

  return {
    name,
    contact: contact.replace(/^\+91/, "").replace(/\s/g, "") || contact,
    email,
    address: line,
    city: state ? (city ? `${city}, ${state}` : state) : city,
    zipCode,
    country: country.length === 2 ? country : "IN",
    shipping_fee: rzpOrder.shipping_fee,
    cod_fee: rzpOrder.cod_fee,
    raw: {
      customer_details: details || null,
      shipping_address: addr || null,
    },
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Magic Checkout often attaches customer_details a moment after payment handler fires.
 */
const fetchRazorpayShipping = async (razorpay, orderId, { tries = 4, delayMs = 800 } = {}) => {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const rzpOrder = await razorpay.orders.fetch(orderId);
      last = rzpOrder;
      const extracted = extractShippingFromRzp(rzpOrder);
      if (extracted && (!isBlank(extracted.address) || !isBlank(extracted.city))) {
        return { rzpOrder, shipping: extracted };
      }
    } catch (e) {
      // keep retrying
    }
    if (i < tries - 1) await sleep(delayMs);
  }
  return {
    rzpOrder: last,
    shipping: extractShippingFromRzp(last),
  };
};

const buildLineItems = (cart = []) =>
  (cart || []).map((item, index) => {
    const price = Number(item.price) || 0;
    const discount = Number(item.discount) || 0;
    const offer =
      discount > 0 ? price - (price * discount) / 100 : price;
    const qty = Number(item.orderQuantity) || 1;
    const offerPaise = toPaise(offer);
    const pricePaise = toPaise(price);
    return {
      sku: String(item._id || item.sku || `sku_${index}`),
      variant_id: String(
        item.selectedSize
          ? `${item._id}_${item.selectedSize}`
          : item._id || `var_${index}`
      ),
      price: pricePaise,
      offer_price: offerPaise,
      quantity: qty,
      name: String(item.title || "Product").slice(0, 250),
      description: String(
        item.selectedSize
          ? `Size: ${item.selectedSize}`
          : item.sku || item.title || "Cotniva product"
      ).slice(0, 250),
      image_url:
        item?.imageURLs?.find((x) => x?.isDefault)?.img ||
        item?.imageURLs?.[0]?.img ||
        item?.img ||
        undefined,
      product_url: item.productUrl || undefined,
      notes: {
        size: item.selectedSize || "",
      },
    };
  });

/**
 * Deprecated — stock is only reserved through Magic Checkout.
 */
exports.createRazorpayOrder = async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "This endpoint is deprecated. Use Magic Checkout.",
  });
};

/**
 * Magic Checkout order — requires line_items + line_items_total.
 * Body: { cart, amount?, currency?, receipt?, notes?, shippingCost? }
 * Shipping is resolved from store settings (client shippingCost is ignored for payable).
 * amount = items total + shipping - discount (final payable). If omitted, computed from cart.
 */
exports.createMagicCheckoutOrder = async (req, res, next) => {
  try {
    const {
      cart = [],
      amount,
      currency = "INR",
      receipt,
      notes,
      discount = 0,
      shipping,
    } = req.body || {};

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart is required for Magic Checkout",
      });
    }

    const lineItems = buildLineItems(cart).map((li) => {
      // image_url required by Magic if showing images — drop if missing
      if (!li.image_url) delete li.image_url;
      if (!li.product_url) delete li.product_url;
      return li;
    });

    const lineItemsTotal = lineItems.reduce(
      (sum, li) => sum + Number(li.offer_price) * Number(li.quantity),
      0
    );

    const storeShip = await getStoreShippingSettings();
    const subTotalRupees = lineItemsTotal / 100;
    const shippingCost = resolveShippingCostRupees(subTotalRupees, storeShip);
    const discountPaise = toPaise(discount);
    const shippingPaise = toPaise(shippingCost);
    const computedPayable = Math.max(
      0,
      lineItemsTotal - discountPaise + shippingPaise
    );
    // Prefer server-computed payable so Buy Now / checkout cannot omit delivery
    const payable =
      amount != null && Math.abs(toPaise(amount) - computedPayable) <= 1
        ? toPaise(amount)
        : computedPayable;

    if (!payable || payable < 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid Magic Checkout amount",
      });
    }

    let reserved = [];
    try {
      reserved = await reserveCartStock(cart);
    } catch (stockErr) {
      const status = stockErr.statusCode || 500;
      if (status === 409 || status === 400) {
        return res.status(status).json({
          success: false,
          message: stockErr.message,
          code: stockErr.code || "STOCK_ERROR",
        });
      }
      throw stockErr;
    }

    const razorpay = getRazorpay();
    let order;
    try {
      order = await razorpay.orders.create({
        amount: payable,
        currency,
        receipt: String(receipt || `magic_${Date.now()}`).slice(0, 40),
        line_items_total: lineItemsTotal,
        line_items: lineItems,
        notes: {
          ...(notes || {}),
          source: "magic_checkout",
          discount_paise: String(discountPaise),
          shipping_paise: String(shippingPaise),
          delivery_charge: String(storeShip.deliveryCharge),
          free_shipping_above: String(storeShip.freeShippingAbove),
          stock_reserved: "1",
        },
      });
    } catch (rzpErr) {
      await restoreReservations(reserved);
      throw rzpErr;
    }

    const releaseToken = newReleaseToken();
    const ship = shipping && typeof shipping === "object" ? shipping : {};
    const orderDraft = {
      cart,
      user: notes?.userId || ship.user || null,
      name: ship.name || "",
      address: ship.address || "",
      city: ship.city || "",
      zipCode: ship.zipCode || "",
      country: ship.country || "India",
      contact: ship.contact || "",
      email: ship.email || "",
      orderNote: ship.orderNote || "",
      subTotal: subTotalRupees,
      shippingCost: Number(shippingCost) || 0,
      discount: Number(discount) || 0,
      totalAmount: payable / 100,
      paymentMethod: "Razorpay",
    };

    try {
      await saveHold(order.id, reserved, { releaseToken, orderDraft });
    } catch (holdErr) {
      await restoreReservations(reserved);
      console.log("stock hold save failed:", holdErr.message);
      return res.status(500).json({
        success: false,
        message: "Could not lock stock for this order. Please try again.",
      });
    }

    res.status(200).json({
      success: true,
      key: secret.razorpay_key_id,
      order,
      releaseToken,
      line_items_total: lineItemsTotal,
      shippingCost: Number(shippingCost) || 0,
      deliveryCharge: storeShip.deliveryCharge,
      freeShippingAbove: storeShip.freeShippingAbove,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const findExistingPaidOrder = async (razorpay_order_id, razorpay_payment_id) => {
  if (razorpay_payment_id) {
    const byPay = await Order.findOne({
      "paymentIntent.razorpay_payment_id": razorpay_payment_id,
    });
    if (byPay) return byPay;
  }
  if (razorpay_order_id) {
    return Order.findOne({
      "paymentIntent.razorpay_order_id": razorpay_order_id,
    });
  }
  return null;
};

/**
 * Always try confirmed email+WhatsApp (idempotent).
 * Needed when Razorpay webhook creates the order first and client verify
 * returns duplicate — otherwise local never sends notifications.
 */
const ensureConfirmedNotifications = (order, reason = "persist") => {
  if (!order?._id) return;
  Promise.resolve()
    .then(async () => {
      // Clear hung sending locks if mail was never marked sent
      const markers = await Order.findById(order._id)
        .select("emailsSent emailsSending whatsappSent whatsappSending")
        .lean();
      if (markers && !markers.emailsSent?.confirmed) {
        await Order.updateOne(
          { _id: order._id },
          {
            $unset: {
              "emailsSending.confirmed": 1,
              "emailsSending.admin_new_order": 1,
            },
          }
        );
      }
      if (markers && !markers.whatsappSent?.confirmed) {
        await Order.updateOne(
          { _id: order._id },
          { $unset: { "whatsappSending.confirmed": 1 } }
        );
      }
      const full = await Order.findById(order._id);
      if (!full) return null;
      console.log(
        `[order-notify] ensure confirmed (${reason}) order=${full._id} email=${full.email}`
      );
      return onOrderConfirmedCreated(full);
    })
    .catch((e) => console.error("confirm notify failed:", e.message));
};

const isDuplicateKey = (err) =>
  err?.code === 11000 || String(err?.message || "").includes("E11000");

const fillOrderDefaults = (orderData, shipping) => {
  if (shipping) {
    if (isBlank(orderData.name) && shipping.name) orderData.name = shipping.name;
    if (isBlank(orderData.address) && shipping.address) {
      orderData.address = shipping.address;
    }
    if (isBlank(orderData.city) && shipping.city) orderData.city = shipping.city;
    if (isBlank(orderData.zipCode) && shipping.zipCode) {
      orderData.zipCode = shipping.zipCode;
    }
    if (isBlank(orderData.country) && shipping.country) {
      orderData.country = shipping.country;
    }
    if (isBlank(orderData.contact) && shipping.contact) {
      orderData.contact = shipping.contact;
    }
    if (isBlank(orderData.email) && shipping.email) orderData.email = shipping.email;
  }
  orderData.name = pick(orderData.name, "Customer");
  orderData.address = pick(orderData.address, "Address not provided");
  orderData.city = pick(orderData.city, "—");
  orderData.country = pick(orderData.country, "IN");
  orderData.zipCode = pick(orderData.zipCode, "000000");
  orderData.contact = pick(orderData.contact, "0000000000");
  orderData.email = pick(orderData.email, "orders@cotniva.com");
  orderData.subTotal = Number(orderData.subTotal) || 0;
  orderData.shippingCost = Number(orderData.shippingCost) || 0;
  orderData.discount = Number(orderData.discount) || 0;
  orderData.totalAmount = Number(orderData.totalAmount) || 0;
  orderData.cart = orderData.cart || [];
  return orderData;
};

const razorpayOrderIsPaid = (rzpOrder) => {
  if (!rzpOrder) return false;
  if (String(rzpOrder.status).toLowerCase() === "paid") return true;
  return Number(rzpOrder.amount_paid) > 0;
};

const releaseHoldIfUnpaid = async (razorpay_order_id) => {
  if (!razorpay_order_id) return { paid: false };
  try {
    const razorpay = getRazorpay();
    const rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
    if (razorpayOrderIsPaid(rzpOrder)) {
      return { paid: true, rzpOrder };
    }
    await releaseHold(razorpay_order_id, { internal: true });
    return { paid: false, rzpOrder };
  } catch (e) {
    await releaseHold(razorpay_order_id, { internal: true });
    return { paid: false };
  }
};

const persistVerifiedOrder = async ({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
  orderPayload,
}) => {
  const already = await findExistingPaidOrder(
    razorpay_order_id,
    razorpay_payment_id
  );
  if (already) {
    await commitHold(razorpay_order_id).catch(() => {});
    ensureConfirmedNotifications(already, "duplicate-early");
    return { order: already, duplicate: true };
  }

  const lock = await acquirePersistLock(razorpay_payment_id, razorpay_order_id);
  if (!lock.acquired) {
    if (lock.reason === "order_exists" && lock.order) {
      await commitHold(razorpay_order_id).catch(() => {});
      ensureConfirmedNotifications(lock.order, "duplicate-lock-exists");
      return { order: lock.order, duplicate: true };
    }
    if (lock.reason === "already_refunded") {
      const err = new Error(
        "This payment was refunded before the order could be saved. Please try checkout again — you have not been charged."
      );
      err.statusCode = 409;
      err.code = "ALREADY_REFUNDED";
      throw err;
    }
    const raced = await findExistingPaidOrder(
      razorpay_order_id,
      razorpay_payment_id
    );
    if (raced) {
      await commitHold(razorpay_order_id).catch(() => {});
      ensureConfirmedNotifications(raced, "duplicate-race");
      return { order: raced, duplicate: true };
    }
    const err = new Error(
      "Payment is already being persisted. Please wait a moment and refresh."
    );
    err.statusCode = 409;
    err.code = "PERSIST_IN_PROGRESS";
    throw err;
  }

  const {
    status: _ignoreStatus,
    paymentStatus: _ignorePaymentStatus,
    statusHistory: _ignoreHistory,
    emailsSent: _ignoreEmails,
    refund: _ignoreRefund,
    cancellation: _ignoreCancel,
    ...safePayload
  } = orderPayload || {};

  let extraReserved = null;
  let inventoryReserved = false;

  try {
    const hold = await getHold(razorpay_order_id);
    inventoryReserved =
      hold?.status === "held" || hold?.status === "committed";

    if (!hold || hold.status === "released") {
      extraReserved = await reserveCartStock(safePayload.cart || []);
      inventoryReserved = true;
    }

    let rzpOrder = null;
    let shipping = null;
    try {
      const razorpay = getRazorpay();
      const fetched = await fetchRazorpayShipping(razorpay, razorpay_order_id, {
        tries: 2,
        delayMs: 400,
      });
      rzpOrder = fetched.rzpOrder;
      shipping = fetched.shipping;
    } catch (e) {
      // frontend address is source of truth
    }

    const orderData = fillOrderDefaults(
      {
        ...safePayload,
        paymentMethod: safePayload.paymentMethod || "Razorpay",
        // Client must never control fulfillment/payment status
        status: "confirmed",
        paymentStatus: "paid",
        refund: { status: "not_required" },
        statusHistory: [
          {
            from: null,
            to: "confirmed",
            at: new Date(),
            source: "payment",
            note: "Auto-confirmed after successful Razorpay payment",
          },
        ],
        emailsSent: {},
        paymentIntent: {
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature: razorpay_signature || "",
          gateway: "razorpay",
          shipping_address: shipping?.raw?.shipping_address || null,
          customer_details:
            shipping?.raw?.customer_details || rzpOrder?.customer_details || null,
          shipping_fee: rzpOrder?.shipping_fee ?? shipping?.shipping_fee ?? null,
          cod_fee: rzpOrder?.cod_fee ?? shipping?.cod_fee ?? null,
          inventoryReserved: Boolean(inventoryReserved),
          inventoryRestored: false,
        },
      },
      shipping
    );

    let orderItems;
    try {
      orderItems = await Order.create(orderData);
    } catch (createErr) {
      if (isDuplicateKey(createErr)) {
        const existing = await findExistingPaidOrder(
          razorpay_order_id,
          razorpay_payment_id
        );
        if (existing) {
          if (extraReserved) await restoreReservations(extraReserved);
          await commitHold(razorpay_order_id).catch(() => {});
          await markPaymentAttemptOrderCreated(
            razorpay_payment_id,
            existing._id,
            razorpay_order_id
          );
          ensureConfirmedNotifications(existing, "duplicate-e11000");
          return { order: existing, duplicate: true };
        }
        // Duplicate key is unrelated to this payment (e.g. invoice race) —
        // do NOT blind-refund a captured payment.
        if (extraReserved) {
          await restoreReservations(extraReserved);
        } else {
          await releaseHold(razorpay_order_id, { internal: true }).catch(
            () => {}
          );
        }
        console.log(
          "[refund]",
          JSON.stringify({
            timestamp: new Date().toISOString(),
            payment_id: razorpay_payment_id || null,
            razorpay_order_id: razorpay_order_id || null,
            reason: "create_duplicate_key_unrelated",
            source: "persistVerifiedOrder",
            order_id: null,
            status: "skipped",
            skip_reason: "e11000_no_matching_order",
            refund_id: null,
          })
        );
        throw createErr;
      }

      if (extraReserved) {
        await restoreReservations(extraReserved);
      } else {
        await releaseHold(razorpay_order_id, { internal: true }).catch(() => {});
      }
      // Release lock so client verify can retry. Do NOT auto-refund here —
      // webhook/client races were refunding successful payments incorrectly.
      // Only OUT_OF_STOCK paths should call safeAutoRefundPayment.
      await releasePersistLock(razorpay_payment_id).catch(() => {});
      console.error(
        "[persistVerifiedOrder] order create failed (no auto-refund):",
        createErr.message
      );
      throw createErr;
    }

    await markPaymentAttemptOrderCreated(
      razorpay_payment_id,
      orderItems._id,
      razorpay_order_id
    );

    if (extraReserved) {
      await attachCommittedHold(razorpay_order_id, extraReserved, {
        orderDraft: { cart: safePayload.cart || [] },
      }).catch((e) => console.log("save committed hold:", e.message));
    } else {
      await commitHold(razorpay_order_id).catch((e) =>
        console.log("commit stock hold:", e.message)
      );
    }

    notifyNewOrder(orderItems, "payment_success").catch((e) =>
      console.log("notify payment_success:", e.message)
    );
    ensureConfirmedNotifications(orderItems, "created");
    if (orderItems.user) {
      trackCustomerActivity(orderItems.user, "order_placed", {
        orderId: orderItems._id,
        invoice: orderItems.invoice,
        totalAmount: orderItems.totalAmount,
        paymentMethod: orderItems.paymentMethod,
      }).catch(() => {});
    }

    return { order: orderItems, duplicate: false };
  } finally {
    await releasePersistLock(razorpay_payment_id).catch(() => {});
  }
};

/**
 * Verify Razorpay payment signature and persist Cotniva order.
 * Body includes razorpay_* fields + order payload (same shape as saveOrder).
 */
exports.verifyRazorpayPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      ...orderPayload
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      await releaseHoldIfUnpaid(razorpay_order_id);
      await notifyPaymentFailed({
        relatedCustomerId: orderPayload?.user,
        reason: "Missing Razorpay payment fields",
        amount: orderPayload?.totalAmount,
        email: orderPayload?.email,
        name: orderPayload?.name,
        contact: orderPayload?.contact,
        paymentMethod: orderPayload?.paymentMethod || "Razorpay",
        meta: { razorpay_order_id },
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        message: "Missing Razorpay payment fields",
      });
    }

    const expected = crypto
      .createHmac("sha256", secret.razorpay_key_secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      const unpaid = await releaseHoldIfUnpaid(razorpay_order_id);
      await notifyPaymentFailed({
        relatedCustomerId: orderPayload?.user,
        reason: "Invalid payment signature",
        amount: orderPayload?.totalAmount,
        email: orderPayload?.email,
        name: orderPayload?.name,
        contact: orderPayload?.contact,
        paymentMethod: orderPayload?.paymentMethod || "Razorpay",
        meta: { razorpay_order_id, razorpay_payment_id },
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        message: unpaid.paid
          ? "Invalid payment signature. If money was captured, the order will be completed via webhook."
          : "Invalid payment signature",
      });
    }

    try {
      const result = await persistVerifiedOrder({
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        orderPayload,
      });
      return res.status(200).json({
        success: true,
        message: result.duplicate
          ? "Payment already verified"
          : "Payment verified and order saved",
        order: result.order,
      });
    } catch (stockErr) {
      // Webhook often wins the persist lock — wait for that order; NEVER refund.
      if (stockErr?.code === "PERSIST_IN_PROGRESS") {
        for (let i = 0; i < 10; i += 1) {
          await sleep(500);
          const existing = await findExistingPaidOrder(
            razorpay_order_id,
            razorpay_payment_id
          );
          if (existing) {
            await commitHold(razorpay_order_id).catch(() => {});
            return res.status(200).json({
              success: true,
              message: "Payment already verified",
              order: existing,
            });
          }
        }
        return res.status(409).json({
          success: false,
          message:
            "Payment is being finalized. Please check My Orders in a moment — do not pay again.",
          code: "PERSIST_IN_PROGRESS",
        });
      }

      if (stockErr?.code === "ALREADY_REFUNDED") {
        await notifyPaymentFailed({
          relatedCustomerId: orderPayload?.user,
          reason: stockErr.message,
          amount: orderPayload?.totalAmount,
          email: orderPayload?.email,
          name: orderPayload?.name,
          contact: orderPayload?.contact,
          paymentMethod: orderPayload?.paymentMethod || "Razorpay",
          meta: { razorpay_order_id, razorpay_payment_id },
        }).catch(() => {});
        return res.status(409).json({
          success: false,
          message: stockErr.message,
          code: "ALREADY_REFUNDED",
        });
      }

      // Only real stock failures should auto-refund a captured payment.
      if (stockErr?.code === "OUT_OF_STOCK") {
        await safeAutoRefundPayment({
          razorpay_payment_id,
          razorpay_order_id,
          reason: "out_of_stock",
          source: "verifyRazorpayPayment",
        });
        await notifyPaymentFailed({
          relatedCustomerId: orderPayload?.user,
          reason: stockErr.message,
          amount: orderPayload?.totalAmount,
          email: orderPayload?.email,
          name: orderPayload?.name,
          contact: orderPayload?.contact,
          paymentMethod: orderPayload?.paymentMethod || "Razorpay",
          meta: { razorpay_order_id, razorpay_payment_id },
        }).catch(() => {});
        return res.status(409).json({
          success: false,
          message:
            stockErr.message ||
            "This size is no longer in stock. A refund has been initiated.",
          code: "OUT_OF_STOCK",
        });
      }
      throw stockErr;
    }
  } catch (error) {
    console.log(error);
    next(error);
  }
};

exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = secret.razorpay_webhook_secret;
    if (!webhookSecret) {
      return res.status(503).json({
        success: false,
        message: "Webhook secret is not configured",
      });
    }

    const raw =
      Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(raw)
      .digest("hex");
    if (!signature || expected !== signature) {
      return res.status(400).json({ success: false, message: "Invalid webhook signature" });
    }

    const payload = JSON.parse(raw.toString("utf8"));
    const event = payload?.event;
    const payment = payload?.payload?.payment?.entity;
    const orderEntity = payload?.payload?.order?.entity;
    const refundEntity = payload?.payload?.refund?.entity;
    const razorpay_order_id = payment?.order_id || orderEntity?.id;
    const razorpay_payment_id =
      payment?.id ||
      refundEntity?.payment_id ||
      orderEntity?.payments?.[0];

    if (
      event === "refund.processed" ||
      event === "refund.created" ||
      event === "payment.refunded"
    ) {
      const paymentId =
        razorpay_payment_id ||
        refundEntity?.payment_id ||
        payment?.id;
      const refundId = refundEntity?.id || payment?.refund_id || "";
      const amount =
        refundEntity?.amount != null
          ? Number(refundEntity.amount) / 100
          : payment?.amount_refunded != null
            ? Number(payment.amount_refunded) / 100
            : undefined;
      await applyRazorpayRefundWebhook({
        razorpay_payment_id: paymentId,
        refundId,
        amount,
        event,
      });
      return res.status(200).json({ success: true });
    }

    if (event === "payment.failed") {
      if (razorpay_order_id) {
        const hold = await getHold(razorpay_order_id).catch(() => null);
        const draft = hold?.orderDraft || {};
        await notifyPaymentFailed({
          relatedCustomerId: draft.user,
          reason:
            payment?.error_description ||
            payment?.error_reason ||
            "Payment failed at Razorpay",
          amount:
            draft.totalAmount ??
            (payment?.amount != null ? payment.amount / 100 : undefined),
          email: draft.email,
          name: draft.name,
          contact: draft.contact,
          paymentMethod: "Razorpay",
          meta: {
            razorpay_order_id,
            razorpay_payment_id,
            event,
          },
        }).catch(() => {});
        await releaseHold(razorpay_order_id, { internal: true });
      }
      return res.status(200).json({ success: true });
    }

    if (
      event === "payment.captured" ||
      event === "order.paid"
    ) {
      if (!razorpay_order_id) {
        return res.status(200).json({ success: true, skipped: true });
      }
      const existing = await findExistingPaidOrder(
        razorpay_order_id,
        razorpay_payment_id
      );
      if (existing) {
        await commitHold(razorpay_order_id).catch(() => {});
        ensureConfirmedNotifications(existing, "webhook-duplicate");
        return res.status(200).json({ success: true, duplicate: true });
      }

      const hold = await getHold(razorpay_order_id);
      const draft = hold?.orderDraft || {};
      const orderPayload = {
        user: draft.user,
        cart: draft.cart || [],
        name: draft.name,
        address: draft.address,
        city: draft.city,
        zipCode: draft.zipCode,
        country: draft.country || "IN",
        contact: draft.contact,
        email: draft.email,
        subTotal: draft.subTotal,
        shippingCost: draft.shippingCost,
        discount: draft.discount,
        totalAmount: draft.totalAmount,
        paymentMethod: "Razorpay",
        orderNote: draft.orderNote || "",
      };

      const draftReady =
        Boolean(orderPayload.user) &&
        Array.isArray(orderPayload.cart) &&
        orderPayload.cart.length > 0 &&
        Boolean(orderPayload.address) &&
        Boolean(orderPayload.contact);

      // Prefer client verify when shipping draft is incomplete — never refund here.
      if (!draftReady) {
        await commitHold(razorpay_order_id).catch(() => {});
        return res.status(200).json({
          success: true,
          pending_verify: true,
          message:
            "Stock committed; waiting for client verify to save order details",
        });
      }

      try {
        await persistVerifiedOrder({
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature: `webhook:${event}`,
          orderPayload,
        });
      } catch (persistErr) {
        if (
          persistErr?.code === "PERSIST_IN_PROGRESS" ||
          persistErr?.code === "ALREADY_REFUNDED"
        ) {
          return res.status(200).json({
            success: true,
            pending: true,
            message: persistErr.message,
          });
        }
        // Do not refund from webhook on create errors — client verify is source of truth.
        console.error(
          "razorpay webhook persist failed (no refund):",
          persistErr.message
        );
        return res.status(200).json({
          success: true,
          pending_verify: true,
          message: persistErr.message,
        });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ success: true, ignored: event });
  } catch (error) {
    console.log("razorpay webhook:", error.message);
    res.status(500).json({ success: false, message: "webhook_failed" });
  }
};

/**
 * Re-fetch shipping address from Razorpay for an existing Cotniva order.
 * Useful when Magic Checkout address landed after first save.
 */
exports.syncRazorpayAddress = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const rzpOrderId = order.paymentIntent?.razorpay_order_id;
    if (!rzpOrderId) {
      return res.status(400).json({
        success: false,
        message: "No Razorpay order id on this order",
      });
    }

    const razorpay = getRazorpay();
    const { rzpOrder, shipping } = await fetchRazorpayShipping(razorpay, rzpOrderId, {
      tries: 5,
      delayMs: 700,
    });

    if (!shipping || (isBlank(shipping.address) && isBlank(shipping.city))) {
      return res.status(404).json({
        success: false,
        message:
          "Razorpay has not returned a shipping address yet. Try again in a few seconds.",
        razorpay_order: rzpOrder || null,
      });
    }

    if (!isBlank(shipping.name)) order.name = shipping.name;
    if (!isBlank(shipping.address)) order.address = shipping.address;
    if (!isBlank(shipping.city)) order.city = shipping.city;
    if (!isBlank(shipping.zipCode)) order.zipCode = shipping.zipCode;
    if (!isBlank(shipping.country)) order.country = shipping.country;
    if (!isBlank(shipping.contact)) order.contact = shipping.contact;
    if (!isBlank(shipping.email)) order.email = shipping.email;
    if (shipping.shipping_fee != null) {
      order.shippingCost = Number(shipping.shipping_fee) / 100;
    }

    order.paymentIntent = {
      ...(order.paymentIntent?.toObject?.() || order.paymentIntent || {}),
      shipping_address: shipping.raw?.shipping_address || null,
      customer_details: shipping.raw?.customer_details || null,
      shipping_fee: rzpOrder?.shipping_fee ?? null,
      cod_fee: rzpOrder?.cod_fee ?? null,
      address_synced_at: new Date().toISOString(),
    };

    await order.save();
    const populated = await Order.findById(order._id).populate("user");

    res.status(200).json({
      success: true,
      message: "Address synced from Razorpay",
      order: populated,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

/** Magic Checkout shipping-info callback (public — configure in Razorpay dashboard) */
exports.magicShippingInfo = async (req, res) => {
  try {
    const body = req.method === "GET" ? req.query : req.body;
    const addresses = body?.addresses || [];
    const storeShip = await getStoreShippingSettings();
    const shippingFeePaise = toPaise(storeShip.deliveryCharge);
    // Prefer notes shipping if present; default free above threshold via zero fee + standard
    const responseAddresses = (addresses.length ? addresses : [{ id: "0" }]).map(
      (a) => ({
        id: String(a.id ?? "0"),
        zipcode: a.zipcode || a.zipCode || "",
        state_code: a.state_code || "",
        country: a.country || "IN",
        shipping_methods: [
          {
            id: "standard",
            name: "Standard delivery",
            description:
              storeShip.freeShippingAbove > 0
                ? `Delivery ₹${storeShip.deliveryCharge} · free above ₹${storeShip.freeShippingAbove}`
                : `Delivery ₹${storeShip.deliveryCharge}`,
            serviceability: true,
            cod: true,
            // Amount already includes store shipping on create; keep callback fee 0
            // to avoid double-charging when Cotniva address + create path is used.
            shipping_fee: 0,
            cod_fee: 0,
            delivery_date_range: {
              start: Math.floor(Date.now() / 1000) + 7 * 86400,
              end: Math.floor(Date.now() / 1000) + 10 * 86400,
            },
          },
          {
            id: "express",
            name: "Express",
            description: "1–3 business days",
            serviceability: true,
            cod: true,
            shipping_fee: Math.max(shippingFeePaise, 9900),
            cod_fee: 0,
            delivery_date_range: {
              start: Math.floor(Date.now() / 1000) + 1 * 86400,
              end: Math.floor(Date.now() / 1000) + 3 * 86400,
            },
          },
        ],
        cod_serviceability: true,
      })
    );

    res.status(200).json({
      addresses: responseAddresses,
      cod_fee: 0,
      free_shipping_threshold: storeShip.freeShippingAbove,
      delivery_charge: storeShip.deliveryCharge,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "shipping_info_failed" });
  }
};

/** Magic Checkout promotions list (public) */
exports.magicGetPromotions = async (req, res) => {
  res.status(200).json({ promotions: [] });
};

/** Magic Checkout apply promotion (public) */
exports.magicApplyPromotion = async (req, res) => {
  res.status(200).json({
    success: false,
    message: "Promotion not applicable",
    discount: 0,
  });
};

// ---- legacy Stripe (kept as no-op redirect message for old clients) ----
exports.paymentIntent = async (req, res) => {
  res.status(410).json({
    success: false,
    message: "Stripe is disabled. Use Razorpay endpoints.",
  });
};

exports.addOrder = async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "Direct order create is disabled. Use Razorpay Magic Checkout.",
  });
};

exports.getOrders = async (req, res, next) => {
  try {
    const orderItems = await Order.find({}).populate("user");
    res.status(200).json({
      success: true,
      data: orderItems,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

exports.getSingleOrder = async (req, res, next) => {
  try {
    const {
      getAllowedNextStatuses,
      canEmergencyCancel,
    } = require("../services/order-status.service");
    const orderItem = await Order.findById(req.params.id).populate("user");
    if (!orderItem) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const plain = orderItem.toObject ? orderItem.toObject() : orderItem;
    res.status(200).json({
      ...plain,
      allowedNext: getAllowedNextStatuses(plain.status),
      canEmergencyCancel: canEmergencyCancel(plain.status),
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

/** Admin: re-send confirmed email + WhatsApp for an order */
exports.resendOrderConfirmed = async (req, res, next) => {
  try {
    const result = await resendOrderConfirmedNotifications(req.params.id, {
      force: req.body?.force !== false,
    });
    res.status(200).json({
      success: true,
      message: "Confirmation notifications re-triggered",
      result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    next(error);
  }
};

exports.releaseMagicCheckoutStock = async (req, res, next) => {
  try {
    const razorpayOrderId =
      req.body?.razorpay_order_id || req.body?.razorpayOrderId;
    const releaseToken = req.body?.releaseToken || req.body?.release_token;
    if (!razorpayOrderId) {
      return res.status(400).json({
        success: false,
        message: "razorpay_order_id is required",
      });
    }
    const result = await releaseHold(String(razorpayOrderId), { releaseToken });
    if (result.status === "forbidden") {
      return res.status(403).json({
        success: false,
        message: "Invalid stock release token",
      });
    }
    if (result.status === "missing") {
      return res.status(200).json({
        success: true,
        message: "No hold to release",
        status: "missing",
      });
    }
    res.status(200).json({
      success: true,
      message: "Stock released",
      status: result.status,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

exports.updateOrderStatus = async (req, res, next) => {
  try {
    const newStatus = req.body.status;
    const trackingNumber = req.body.trackingNumber;
    const trackingUrl = req.body.trackingUrl;

    const result = await applyFulfillmentStatus({
      orderId: req.params.id,
      nextStatus: newStatus,
      admin: req.user
        ? { _id: req.user._id, email: req.user.email, name: req.user.name }
        : undefined,
      trackingNumber,
      trackingUrl,
    });

    res.status(200).json({
      success: true,
      message: result.unchanged
        ? "Status unchanged"
        : "Status updated successfully",
      order: result.order,
      allowedNext: result.allowedNext,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    console.log(error);
    next(error);
  }
};

exports.emergencyCancelOrder = async (req, res, next) => {
  try {
    const reasonCode = req.body.reasonCode || req.body.reason_code;
    const reasonText = req.body.reason || req.body.reasonText;

    const result = await emergencyCancelOrder({
      orderId: req.params.id,
      reasonCode,
      reasonText,
      admin: req.user
        ? { _id: req.user._id, email: req.user.email, name: req.user.name }
        : undefined,
    });

    const refundFailed = result.refund && result.refund.ok === false;

    res.status(200).json({
      success: true,
      message: result.alreadyCancelled
        ? "Order was already cancelled"
        : refundFailed
          ? "Order cancelled. Refund failed — manual action required."
          : result.refund?.status === "completed"
            ? "Order cancelled and refund completed"
            : "Order cancelled and refund initiated",
      order: result.order,
      refund: result.refund,
      inventoryRestored: result.inventoryRestored,
      alreadyCancelled: result.alreadyCancelled,
      cancelReasons: CANCEL_REASONS,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    console.log(error);
    next(error);
  }
};

exports.getOrderStatusMeta = async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      cancelReasons: CANCEL_REASONS,
      transitions: {
        confirmed: ["processing"],
        processing: ["packed"],
        packed: ["shipped"],
        shipped: ["out_for_delivery"],
        out_for_delivery: ["delivered"],
      },
      emergencyCancelFrom: ["confirmed", "pending", "processing", "packed"],
    },
  });
};

exports.updateAdminNotes = async (req, res, next) => {
  try {
    const notes = req.body.adminNotes ?? req.body.notes ?? "";
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: { adminNotes: String(notes) } },
      { new: true }
    ).populate("user");
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    res.status(200).json({
      success: true,
      message: "Notes saved",
      order,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};
