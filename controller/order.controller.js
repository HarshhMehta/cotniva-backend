const crypto = require("crypto");
const Razorpay = require("razorpay");
const { secret } = require("../config/secret");
const Order = require("../model/Order");
const {
  notifyNewOrder,
  notifyPaymentFailed,
  notifyOrderCancelled,
} = require("../services/notification.service");
const { trackCustomerActivity } = require("../services/customer-activity.service");
const {
  reserveCartStock,
  saveHold,
  getHold,
  commitHold,
  releaseHold,
  restoreCommittedHold,
  restoreReservations,
  attachCommittedHold,
  newReleaseToken,
} = require("../services/inventory.service");

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
      shippingCost = 0,
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

    const discountPaise = toPaise(discount);
    const shippingPaise = toPaise(shippingCost);
    const payable =
      amount != null
        ? toPaise(amount)
        : Math.max(0, lineItemsTotal - discountPaise + shippingPaise);

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
          stock_reserved: "1",
        },
      });
    } catch (rzpErr) {
      await restoreReservations(reserved);
      throw rzpErr;
    }

    const releaseToken = newReleaseToken();
    const orderDraft = {
      cart,
      user: notes?.userId || null,
      subTotal: (payable - shippingPaise + discountPaise) / 100,
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
    return { order: already, duplicate: true };
  }

  const razorpay = getRazorpay();
  const refundPayment = async () => {
    if (!razorpay_payment_id) return;
    try {
      await razorpay.payments.refund(razorpay_payment_id);
    } catch (refundErr) {
      console.log("razorpay refund failed:", refundErr.message);
    }
  };

  const hold = await getHold(razorpay_order_id);
  let extraReserved = null;
  let inventoryReserved =
    hold?.status === "held" || hold?.status === "committed";

  if (!hold || hold.status === "released") {
    extraReserved = await reserveCartStock(orderPayload.cart || []);
    inventoryReserved = true;
  }

  let rzpOrder = null;
  let shipping = null;
  try {
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
      ...orderPayload,
      paymentMethod: orderPayload.paymentMethod || "Razorpay",
      status: (orderPayload.status || "pending").toLowerCase(),
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
        return { order: existing, duplicate: true };
      }
    }
    if (extraReserved) {
      await restoreReservations(extraReserved);
    } else {
      await releaseHold(razorpay_order_id, { internal: true }).catch(() => {});
    }
    await refundPayment();
    throw createErr;
  }

  if (extraReserved) {
    await attachCommittedHold(razorpay_order_id, extraReserved, {
      orderDraft: { cart: orderPayload.cart || [] },
    }).catch((e) => console.log("save committed hold:", e.message));
  } else {
    await commitHold(razorpay_order_id).catch((e) =>
      console.log("commit stock hold:", e.message)
    );
  }

  notifyNewOrder(orderItems, "payment_success").catch((e) =>
    console.log("notify payment_success:", e.message)
  );
  if (orderItems.user) {
    trackCustomerActivity(orderItems.user, "order_placed", {
      orderId: orderItems._id,
      invoice: orderItems.invoice,
      totalAmount: orderItems.totalAmount,
      paymentMethod: orderItems.paymentMethod,
    }).catch(() => {});
  }

  return { order: orderItems, duplicate: false };
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
      if (stockErr.statusCode === 409 || stockErr.code === "OUT_OF_STOCK") {
        try {
          const razorpay = getRazorpay();
          await razorpay.payments.refund(razorpay_payment_id);
        } catch (refundErr) {
          console.log("razorpay refund failed:", refundErr.message);
        }
        await notifyPaymentFailed({
          relatedCustomerId: orderPayload?.user,
          reason: stockErr.message,
          amount: orderPayload?.totalAmount,
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
    const razorpay_order_id = payment?.order_id || orderEntity?.id;
    const razorpay_payment_id = payment?.id || orderEntity?.payments?.[0];

    if (event === "payment.failed") {
      if (razorpay_order_id) {
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
        status: "pending",
        orderNote: draft.orderNote || "",
      };

      if (!orderPayload.user || !orderPayload.cart?.length) {
        await commitHold(razorpay_order_id).catch(() => {});
        return res.status(200).json({
          success: true,
          pending_verify: true,
          message: "Stock committed; waiting for client verify to save order details",
        });
      }

      await persistVerifiedOrder({
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature: `webhook:${event}`,
        orderPayload,
      });
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
    const FREE_SHIP = 1299;
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
            name: "Standard",
            description: "7–10 business days",
            serviceability: true,
            cod: true,
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
            shipping_fee: 9900,
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
      // hint unused by some SDKs
      free_shipping_threshold: FREE_SHIP,
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
    const orderItem = await Order.findById(req.params.id).populate("user");
    res.status(200).json(orderItem);
  } catch (error) {
    console.log(error);
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
  const newStatus = req.body.status;
  try {
    const existing = await Order.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const goingCancel =
      String(newStatus).toLowerCase() === "cancel" &&
      String(existing.status || "").toLowerCase() !== "cancel";

    if (goingCancel && existing.paymentIntent?.inventoryReserved && !existing.paymentIntent?.inventoryRestored) {
      const restored = await restoreCommittedHold(
        existing.paymentIntent?.razorpay_order_id,
        existing.cart
      );
      if (restored) {
        existing.paymentIntent = {
          ...(existing.paymentIntent?.toObject?.() || existing.paymentIntent || {}),
          inventoryRestored: true,
        };
      }
    }

    existing.status = newStatus;
    const order = await existing.save();

    if (String(newStatus).toLowerCase() === "cancel") {
      notifyOrderCancelled(order).catch((e) =>
        console.log("notify cancel:", e.message)
      );
    }

    res.status(200).json({
      success: true,
      message: "Status updated successfully",
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
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
