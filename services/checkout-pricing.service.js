const mongoose = require("mongoose");
const Product = require("../model/Products");
const Coupon = require("../model/Coupon");

const STORE_DEFAULTS = {
  deliveryCharge: 100,
  freeShippingAbove: 1299,
};

const MAX_LINE_QTY = 50;

const toPaise = (amount) => Math.round(Number(amount || 0) * 100);

const {
  getShippingSettings,
} = require("./store-settings-cache.service");

const getStoreShippingSettings = async () => getShippingSettings();

const resolveShippingCostRupees = (subTotalRupees, settings) => {
  const charge = Math.max(0, Number(settings?.deliveryCharge) || 0);
  const threshold = Math.max(0, Number(settings?.freeShippingAbove) || 0);
  const total = Math.max(0, Number(subTotalRupees) || 0);
  if (threshold > 0 && total >= threshold) return 0;
  return charge;
};

const offerUnitPrice = (price, discountPct) => {
  const p = Math.max(0, Number(price) || 0);
  const d = Math.max(0, Number(discountPct) || 0);
  return d > 0 ? p - (p * d) / 100 : p;
};

const isStoreWideCoupon = (productType) => {
  const type = String(productType || "")
    .trim()
    .toLowerCase();
  return (
    !type ||
    type === "all" ||
    type === "general" ||
    type === "any" ||
    type === "clothing"
  );
};

const getCouponCategoryIds = (coupon) => {
  if (!Array.isArray(coupon?.applicableCategories)) return [];
  return coupon.applicableCategories
    .map((c) => String(c?._id || c || "").trim())
    .filter(Boolean);
};

/**
 * Eligible cart lines for a coupon.
 * - Non-empty applicableCategories → match product.category.id
 * - Otherwise fall back to legacy productType matching / store-wide
 */
const getEligibleCartForCoupon = (coupon, trustedCart = []) => {
  const categoryIds = getCouponCategoryIds(coupon);
  if (categoryIds.length > 0) {
    const set = new Set(categoryIds);
    return trustedCart.filter((p) => {
      const cid = String(p?.category?.id || p?.category?._id || "").trim();
      return cid && set.has(cid);
    });
  }

  if (isStoreWideCoupon(coupon?.productType)) {
    return trustedCart;
  }

  const type = String(coupon?.productType || "")
    .trim()
    .toLowerCase();
  return trustedCart.filter(
    (p) => String(p.productType || "").toLowerCase() === type
  );
};

const pricingError = (message, statusCode = 400, code = "PRICING_ERROR") => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
};

/**
 * Validate coupon from DB and compute rupee discount.
 * Never trusts client discount amounts.
 */
const resolveCouponDiscount = async ({
  couponCode,
  trustedCart,
  subTotalRupees,
}) => {
  const code = String(couponCode || "")
    .trim()
    .toUpperCase();
  if (!code) {
    return { discountRupees: 0, coupon: null };
  }

  const coupon = await Coupon.findOne({
    couponCode: new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).lean();

  if (!coupon) {
    throw pricingError("Invalid coupon code", 400, "INVALID_COUPON");
  }
  if (String(coupon.status || "active").toLowerCase() === "inactive") {
    throw pricingError("This coupon is no longer valid", 400, "COUPON_INACTIVE");
  }

  const now = Date.now();
  if (coupon.startTime && new Date(coupon.startTime).getTime() > now) {
    throw pricingError("This coupon is not active yet", 400, "COUPON_NOT_STARTED");
  }
  if (
    !coupon.neverExpires &&
    coupon.endTime &&
    new Date(coupon.endTime).getTime() < now
  ) {
    throw pricingError("This coupon has expired", 400, "COUPON_EXPIRED");
  }

  const maxUses = Number(coupon.maxUses);
  if (Number.isFinite(maxUses) && maxUses > 0) {
    const used = Math.max(0, Number(coupon.usedCount) || 0);
    if (used >= maxUses) {
      throw pricingError(
        "This coupon has reached its maximum number of uses",
        400,
        "COUPON_MAX_USES"
      );
    }
  }

  const minimumAmount = Math.max(0, Number(coupon.minimumAmount) || 0);
  if (minimumAmount > 0 && subTotalRupees + 1e-9 < minimumAmount) {
    throw pricingError(
      `Minimum ₹${minimumAmount} required to apply this coupon`,
      400,
      "COUPON_MIN_AMOUNT"
    );
  }

  const discountType =
    String(coupon.discountType || "percentage").toLowerCase() === "fixed"
      ? "fixed"
      : "percentage";

  const eligible = getEligibleCartForCoupon(coupon, trustedCart);

  if (eligible.length === 0) {
    throw pricingError(
      "This coupon does not apply to items in your cart",
      400,
      "COUPON_NOT_APPLICABLE"
    );
  }

  // Match storefront: coupon applies to list price × qty of eligible lines
  const discountBase = eligible.reduce(
    (sum, item) =>
      sum +
      Math.max(0, Number(item.price) || 0) * (Number(item.orderQuantity) || 1),
    0
  );

  let discountRupees = 0;
  if (discountType === "fixed") {
    const flat = Math.max(0, Number(coupon.discountAmount) || 0);
    discountRupees = Number(Math.min(flat, discountBase, subTotalRupees).toFixed(2));
  } else {
    const pct = Math.max(0, Math.min(100, Number(coupon.discountPercentage) || 0));
    if (pct <= 0) {
      return { discountRupees: 0, coupon };
    }
    discountRupees = Number(((discountBase * pct) / 100).toFixed(2));
    discountRupees = Math.max(0, Math.min(discountRupees, subTotalRupees));
  }

  return { discountRupees, coupon };
};

/**
 * Rebuild cart lines from Mongo product documents.
 * Client may supply: _id, orderQuantity, selectedSize, productUrl (display only).
 * Price / discount / title / images come from DB.
 */
const buildTrustedCheckout = async ({ cart = [], couponCode } = {}) => {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw pricingError("Cart is required for Magic Checkout", 400, "EMPTY_CART");
  }

  const ids = [
    ...new Set(
      cart
        .map((item) => item?._id || item?.id || item?.productId)
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  const objectIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!objectIds.length) {
    throw pricingError("Cart contains invalid product ids", 400, "INVALID_PRODUCT");
  }

  const products = await Product.find({ _id: { $in: objectIds } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const trustedCart = [];
  for (const item of cart) {
    const id = String(item?._id || item?.id || item?.productId || "");
    const product = byId.get(id);
    if (!product) {
      throw pricingError("One or more products are unavailable", 400, "PRODUCT_NOT_FOUND");
    }
    if (String(product.status) === "discontinued") {
      throw pricingError(
        `"${product.title}" is no longer available`,
        400,
        "PRODUCT_DISCONTINUED"
      );
    }

    let qty = Number(item.orderQuantity);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    qty = Math.min(MAX_LINE_QTY, Math.floor(qty));

    const selectedSize = item.selectedSize
      ? String(item.selectedSize).trim()
      : "";

    trustedCart.push({
      _id: product._id,
      title: product.title,
      sku: product.sku || "",
      slug: product.slug || "",
      img:
        product.imageURLs?.find((x) => x?.isDefault)?.img ||
        product.imageURLs?.[0]?.img ||
        "",
      imageURLs: product.imageURLs || [],
      price: Number(product.price) || 0,
      discount: Math.max(0, Number(product.discount) || 0),
      orderQuantity: qty,
      selectedSize,
      productType: product.productType || "general",
      productUrl: item.productUrl || undefined,
      category: product.category || undefined,
      sizes: product.sizes || [],
      sizeInventory: product.sizeInventory || [],
      quantity: product.quantity,
    });
  }

  const lineItems = trustedCart.map((item, index) => {
    const price = Number(item.price) || 0;
    const discount = Number(item.discount) || 0;
    const offer = offerUnitPrice(price, discount);
    const qty = Number(item.orderQuantity) || 1;
    const offerPaise = toPaise(offer);
    const pricePaise = toPaise(price);
    const li = {
      sku: String(item._id || item.sku || `sku_${index}`),
      variant_id: String(
        item.selectedSize ? `${item._id}_${item.selectedSize}` : item._id
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
      image_url: item.img || undefined,
      product_url: item.productUrl || undefined,
      notes: { size: item.selectedSize || "" },
    };
    if (!li.image_url) delete li.image_url;
    if (!li.product_url) delete li.product_url;
    return li;
  });

  const lineItemsTotalPaise = lineItems.reduce(
    (sum, li) => sum + Number(li.offer_price) * Number(li.quantity),
    0
  );
  const subTotalRupees = lineItemsTotalPaise / 100;

  const { discountRupees, coupon } = await resolveCouponDiscount({
    couponCode,
    trustedCart,
    subTotalRupees,
  });

  const storeShip = await getStoreShippingSettings();
  const shippingCost = resolveShippingCostRupees(subTotalRupees, storeShip);
  const discountPaise = toPaise(discountRupees);
  const shippingPaise = toPaise(shippingCost);
  const payablePaise = Math.max(
    0,
    lineItemsTotalPaise - discountPaise + shippingPaise
  );

  if (!payablePaise || payablePaise < 100) {
    throw pricingError("Invalid checkout amount", 400, "INVALID_AMOUNT");
  }

  return {
    trustedCart,
    lineItems,
    lineItemsTotalPaise,
    subTotalRupees,
    shippingCost,
    discountRupees,
    discountPaise,
    shippingPaise,
    payablePaise,
    storeShip,
    couponCode: coupon ? coupon.couponCode : "",
    coupon,
  };
};

module.exports = {
  buildTrustedCheckout,
  getStoreShippingSettings,
  resolveShippingCostRupees,
  offerUnitPrice,
  toPaise,
  STORE_DEFAULTS,
  isStoreWideCoupon,
  getEligibleCartForCoupon,
  resolveCouponDiscount,
  recordCouponUse: async (couponCode) => {
    const code = String(couponCode || "").trim();
    if (!code) return;
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await Coupon.updateOne(
      { couponCode: new RegExp(`^${escaped}$`, "i") },
      { $inc: { usedCount: 1 } }
    );
  },
};
