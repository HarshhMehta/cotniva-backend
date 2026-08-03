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
 * Standard Razorpay order for site checkout (address already collected).
 * Body: { amount, currency?, receipt?, notes?, cart? }
 */
exports.createRazorpayOrder = async (req, res, next) => {
  try {
    const { amount, currency = "INR", receipt, notes, cart } = req.body || {};
    const amountPaise = toPaise(amount);
    if (!amountPaise || amountPaise < 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid order amount",
      });
    }

    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency,
      receipt: String(receipt || `cot_${Date.now()}`).slice(0, 40),
      notes: notes || {},
    });

    res.status(200).json({
      success: true,
      key: secret.razorpay_key_id,
      order,
      cart: cart || [],
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
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

    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
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
      },
    });

    res.status(200).json({
      success: true,
      key: secret.razorpay_key_id,
      order,
      line_items_total: lineItemsTotal,
    });
  } catch (error) {
    console.log(error);
    next(error);
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
      await notifyPaymentFailed({
        relatedCustomerId: orderPayload?.user,
        reason: "Invalid payment signature",
        amount: orderPayload?.totalAmount,
        meta: { razorpay_order_id, razorpay_payment_id },
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature",
      });
    }

    const razorpay = getRazorpay();
    // Optional enrich — never overwrite a real frontend address
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
      // ignore — frontend address is source of truth
    }

    const orderData = {
      ...orderPayload,
      paymentMethod: orderPayload.paymentMethod || "Razorpay",
      status: (orderPayload.status || "pending").toLowerCase(),
      paymentIntent: {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        gateway: "razorpay",
        shipping_address: shipping?.raw?.shipping_address || null,
        customer_details: shipping?.raw?.customer_details || rzpOrder?.customer_details || null,
        shipping_fee: rzpOrder?.shipping_fee ?? shipping?.shipping_fee ?? null,
        cod_fee: rzpOrder?.cod_fee ?? shipping?.cod_fee ?? null,
      },
    };

    // Frontend checkout address is the source of truth.
    // Only fill blanks from Razorpay if customer somehow left them empty.
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
      if (isBlank(orderData.email) && shipping.email) {
        orderData.email = shipping.email;
      }
    }

    // Soft placeholders only if still missing
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

    const orderItems = await Order.create(orderData);

    // Admin bell + customer tracking (non-blocking side effects)
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

    res.status(200).json({
      success: true,
      message: "Payment verified and order saved",
      order: orderItems,
    });
  } catch (error) {
    console.log(error);
    next(error);
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

exports.addOrder = async (req, res, next) => {
  try {
    const payload = { ...req.body };
    if (payload.status) payload.status = String(payload.status).toLowerCase();
    const orderItems = await Order.create(payload);

    const method = String(orderItems.paymentMethod || "").toLowerCase();
    const extra = /cod|cash/.test(method) ? "cod_order" : null;
    notifyNewOrder(orderItems, extra).catch((e) =>
      console.log("notify new order:", e.message)
    );
    if (orderItems.user) {
      trackCustomerActivity(orderItems.user, "order_placed", {
        orderId: orderItems._id,
        invoice: orderItems.invoice,
        totalAmount: orderItems.totalAmount,
        paymentMethod: orderItems.paymentMethod,
      }).catch(() => {});
    }

    res.status(200).json({
      success: true,
      message: "Order added successfully",
      order: orderItems,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
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

exports.updateOrderStatus = async (req, res, next) => {
  const newStatus = req.body.status;
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: { status: newStatus } },
      { new: true }
    );
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

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
