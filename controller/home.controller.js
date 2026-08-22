const { ensureTopBar, toPublicTopBar } = require("./topbar.controller");
const Slider = require("../model/Slider");
const Gallery = require("../model/Gallery");
const Category = require("../model/Category");
const Product = require("../model/Products");

const PRODUCT_CARD_FIELDS =
  "title discount price status tags imageURLs sellCount newArrival createdAt sizes sizeInventory quantity sizeGuide";

async function getTopBarData() {
  const topbar = await ensureTopBar();
  return toPublicTopBar(topbar);
}

async function getSlimNewArrivals() {
  return Product.find({
    $or: [{ newArrival: true }, { tags: "new-arrival" }],
  })
    .select(PRODUCT_CARD_FIELDS)
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
}

async function getSlimBestSellers() {
  const adminSelected = await Product.find({ bestSeller: true })
    .select(PRODUCT_CARD_FIELDS)
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  if (adminSelected.length > 0) return adminSelected;

  const Order = require("../model/Order");
  const totalOrders = await Order.countDocuments();

  if (totalOrders > 0) {
    const auto = await Product.find({ sellCount: { $gt: 0 } })
      .select(PRODUCT_CARD_FIELDS)
      .sort({ sellCount: -1 })
      .limit(8)
      .lean();
    if (auto.length > 0) return auto;
  }

  return Product.find({})
    .select(PRODUCT_CARD_FIELDS)
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
}

async function getSlimCategories(type = "beauty") {
  // Match /api/category/show — visible categories only (not productType-only filter)
  const baseQuery = { status: "Show" };
  const fields = "parent img children products productType status";

  let categories = await Category.find(baseQuery)
    .select(fields)
    .sort({ parent: 1 })
    .lean();

  // Legacy: when type is passed and categories carry productType, prefer that subset
  if (type && categories.some((c) => c.productType)) {
    const typed = categories.filter(
      (c) => String(c.productType || "").toLowerCase() === String(type).toLowerCase()
    );
    if (typed.length > 0) categories = typed;
  }

  return categories;
}

/**
 * Single homepage payload — runs all reads in parallel.
 * Replaces 6 separate client round-trips.
 */
exports.getHomeData = async (req, res, next) => {
  try {
    const type = req.query.type || "beauty";

    const [topbar, sliders, categories, newArrivals, gallery, bestSellers] =
      await Promise.all([
        getTopBarData(),
        Slider.find({ status: "active" }).sort({ order: 1 }).lean(),
        getSlimCategories(type),
        getSlimNewArrivals(),
        Gallery.find({ status: "active" })
          .sort({ order: 1, createdAt: -1 })
          .lean(),
        getSlimBestSellers(),
      ]);

    // Short browser/CDN cache — cuts repeat visits
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");

    res.status(200).json({
      success: true,
      topbar,
      sliders,
      categories,
      newArrivals,
      gallery,
      bestSellers,
    });
  } catch (error) {
    next(error);
  }
};
