const mongoose = require("mongoose");
const Product = require("../model/Products");
const Category = require("../model/Category");

/** Fields needed for shop cards, filters, cart stock refresh (listing only) */
const LISTING_FIELDS =
  "title slug discount price status tags imageURLs sellCount newArrival bestSeller featured createdAt sizes sizeInventory quantity parent children brand category productType";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
const MAX_STOCK_CHECK_ITEMS = 50;

const categoryToSlug = (title = "") =>
  String(title)
    .toLowerCase()
    .replace(/&/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join("-");

const salePriceExpr = (price, discount) => {
  const p = Number(price) || 0;
  const d = Number(discount) || 0;
  return d > 0 ? p - (p * d) / 100 : p;
};

const parseSort = (sortKey) => {
  switch (String(sortKey || "").trim()) {
    case "Best selling":
      return { sellCount: -1, createdAt: -1 };
    case "Alphabetically, A-Z":
      return { title: 1 };
    case "Alphabetically, Z-A":
      return { title: -1 };
    case "Low to High":
      return { price: 1 };
    case "High to Low":
      return { price: -1 };
    case "Date, old to new":
      return { createdAt: 1 };
    case "New Added":
      return { createdAt: -1 };
    case "Featured":
    default:
      return { featured: -1, bestSeller: -1, createdAt: -1 };
  }
};

const buildListingQuery = async (query = {}) => {
  const filters = [];

  if (query.newArrival === "true" || query.newArrivalOnly === "true") {
    filters.push({
      $or: [{ newArrival: true }, { tags: "new-arrival" }],
    });
  }

  const searchText = String(query.search || query.searchText || "").trim();
  if (searchText) {
    const q = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(q, "i");
    filters.push({
      $or: [
        { title: re },
        { parent: re },
        { children: re },
        { tags: re },
      ],
    });
  }

  if (query.status === "on-sale") {
    filters.push({ discount: { $gt: 0 } });
  } else if (query.status === "in-stock") {
    filters.push({ status: "in-stock" });
  }

  const categorySlug = String(query.category || "").trim();
  if (categorySlug) {
    const categories = await Category.find({ status: "Show" })
      .select("parent _id products")
      .lean();
    const match = categories.find(
      (c) => categoryToSlug(c.parent) === categorySlug
    );
    if (match) {
      const categoryId = String(match._id);
      const productIds = (match.products || []).map((id) =>
        mongoose.Types.ObjectId.isValid(id) ? id : null
      ).filter(Boolean);
      const or = [{ "category.id": match._id }, { parent: match.parent }];
      if (productIds.length) or.push({ _id: { $in: productIds } });
      filters.push({ $or: or });
    } else {
      filters.push({
        parent: new RegExp(
          `^${categorySlug.replace(/-/g, "[\\s-]+")}$`,
          "i"
        ),
      });
    }
  }

  const subCategory = String(query.subCategory || "").trim();
  if (subCategory) {
    filters.push({
      children: new RegExp(
        `^${subCategory.replace(/-/g, "[\\s&-]+")}$`,
        "i"
      ),
    });
  }

  const brandSlug = String(query.brand || "").trim();
  if (brandSlug) {
    filters.push({
      "brand.name": new RegExp(
        `^${brandSlug.replace(/-/g, "[\\s&-]+")}$`,
        "i"
      ),
    });
  }

  const minPrice = query.minPrice != null ? Number(query.minPrice) : null;
  const maxPrice = query.maxPrice != null ? Number(query.maxPrice) : null;
  if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
    const priceFilter = {};
    if (Number.isFinite(minPrice)) priceFilter.$gte = minPrice;
    if (Number.isFinite(maxPrice)) priceFilter.$lte = maxPrice;
    filters.push({ price: priceFilter });
  }

  const colorSlug = String(query.color || "").trim();
  if (colorSlug) {
    filters.push({
      "imageURLs.color.name": new RegExp(
        colorSlug.replace(/-/g, "[\\s-]+"),
        "i"
      ),
    });
  }

  const sizeSlug = String(query.size || "").trim();
  if (sizeSlug) {
    const sizeRe = new RegExp(
      `^${sizeSlug.replace(/-/g, "[\\s&-]+")}$`,
      "i"
    );
    filters.push({
      $or: [{ sizes: sizeRe }, { "imageURLs.sizes": sizeRe }],
    });
  }

  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0];
  return { $and: filters };
};

const listProducts = async (query = {}, options = {}) => {
  const { forcePaginate = false } = options;
  const mongoQuery = await buildListingQuery(query);
  const sort = parseSort(query.sort);

  const pageRaw = query.page;
  const limitRaw = query.limit;
  const paginate =
    forcePaginate ||
    pageRaw != null ||
    limitRaw != null ||
    String(query.paginate || "").toLowerCase() === "true";

  if (!paginate) {
    const products = await Product.find(mongoQuery)
      .select(LISTING_FIELDS)
      .sort(sort)
      .lean();
    return { products, pagination: null };
  }

  const page = Math.max(1, parseInt(pageRaw, 10) || DEFAULT_PAGE);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(limitRaw, 10) || DEFAULT_LIMIT)
  );
  const skip = (page - 1) * limit;

  const [total, products] = await Promise.all([
    Product.countDocuments(mongoQuery),
    Product.find(mongoQuery)
      .select(LISTING_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  return {
    products,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

const getProductFacets = async () => {
  const products = await Product.find({})
    .select("price sizes imageURLs brand")
    .lean();

  let maxPrice = 0;
  const colorMap = new Map();
  const sizeSet = new Set();

  products.forEach((p) => {
    const price = Number(p.price) || 0;
    if (price > maxPrice) maxPrice = price;

    (p.sizes || []).forEach((s) => {
      if (s) sizeSet.add(String(s).trim());
    });
    (p.imageURLs || []).forEach((img) => {
      (img.sizes || []).forEach((s) => {
        if (s) sizeSet.add(String(s).trim());
      });
      const name = img?.color?.name;
      if (name) {
        const key = String(name).trim();
        colorMap.set(key, (colorMap.get(key) || 0) + 1);
      }
    });
  });

  const order = ["XS", "S", "M", "L", "XL", "XXL"];
  const sizes = Array.from(sizeSet).sort((a, b) => {
    const ia = order.indexOf(a.toUpperCase());
    const ib = order.indexOf(b.toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const colors = Array.from(colorMap.entries()).map(([name, count]) => ({
    name,
    count,
  }));

  return { maxPrice, sizes, colors };
};

const checkStockForItems = async (items = []) => {
  const normalized = (Array.isArray(items) ? items : [])
    .map((row) => ({
      productId: String(row?.productId || row?._id || "").trim(),
      selectedSize: String(row?.selectedSize || "").trim(),
      quantity: Math.max(0, Number(row?.quantity) || 0),
    }))
    .filter((row) => row.productId);

  if (!normalized.length) {
    return { items: [] };
  }

  if (normalized.length > MAX_STOCK_CHECK_ITEMS) {
    const err = new Error(
      `Cannot check more than ${MAX_STOCK_CHECK_ITEMS} items at once`
    );
    err.statusCode = 400;
    throw err;
  }

  const seen = new Set();
  const unique = normalized.filter((row) => {
    const key = `${row.productId}::${row.selectedSize.toUpperCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ids = unique
    .map((r) => r.productId)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const products = await Product.find({ _id: { $in: ids } })
    .select("_id sizeInventory quantity status sizes")
    .lean();

  const byId = {};
  products.forEach((p) => {
    byId[String(p._id)] = p;
  });

  const getStockForSize = (product, size) => {
    const inv = product?.sizeInventory;
    if (Array.isArray(inv) && inv.length > 0) {
      if (!size) return 0;
      const row = inv.find(
        (r) =>
          String(r?.size || "").trim().toUpperCase() ===
          String(size).trim().toUpperCase()
      );
      const n = Number(row?.quantity);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    const n = Number(product?.quantity);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const result = unique.map((req) => {
    const live = byId[req.productId];
    if (!live) {
      return {
        productId: req.productId,
        _id: req.productId,
        available: false,
        stock: 0,
        status: "out-of-stock",
        sizeInventory: [],
        quantity: 0,
        sizes: [],
      };
    }

    const stock = getStockForSize(live, req.selectedSize);
    const available =
      live.status !== "out-of-stock" &&
      live.status !== "discontinued" &&
      stock > 0;

    return {
      productId: req.productId,
      _id: live._id,
      available,
      stock,
      sizeInventory: live.sizeInventory || [],
      quantity: live.quantity,
      status: live.status,
      sizes: live.sizes || [],
    };
  });

  return { items: result };
};

module.exports = {
  LISTING_FIELDS,
  MAX_LIMIT,
  MAX_STOCK_CHECK_ITEMS,
  listProducts,
  getProductFacets,
  checkStockForItems,
  categoryToSlug,
  salePriceExpr,
};
