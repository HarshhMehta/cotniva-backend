const Brand = require("../model/Brand");
const Category = require("../model/Category");
const Product = require("../model/Products");
const mongoose = require("mongoose");
const { cloudinaryServices } = require("./cloudinary.service");

function slugify(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureUniqueSlug(base, excludeId) {
  let slug = base || "product";
  let n = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const q = { slug: candidate };
    if (excludeId) q._id = { $ne: excludeId };
    const exists = await Product.findOne(q).select("_id").lean();
    if (!exists) return candidate;
    n += 1;
  }
}

// create product service
exports.createProductService = async (data) => {
  const baseSlug = data.slug || slugify(data.title);
  data.slug = await ensureUniqueSlug(baseSlug);
  const product = await Product.create(data);
  const { _id: productId, brand, category } = product;
  // update Brand only if brand id exists
  if (brand?.id) {
    await Brand.updateOne(
      { _id: brand.id },
      { $push: { products: productId } }
    );
  }
  // Category
  if (category?.id) {
    await Category.updateOne(
      { _id: category.id },
      { $push: { products: productId } }
    );
  }
  return product;
};

// create all product service
exports.addAllProductService = async (data) => {
  await Product.deleteMany();
  const products = await Product.insertMany(data);
  for (const product of products) {
    await Brand.findByIdAndUpdate(product.brand.id, {
      $push: { products: product._id },
    });
    await Category.findByIdAndUpdate(product.category.id, {
      $push: { products: product._id },
    });
  }
  return products;
};

// get product data
exports.getAllProductsService = async () => {
  const products = await Product.find({})
    .populate("reviews")
    .sort({ createdAt: -1 }); // -1 = DESC, 1 = ASC
  return products;
};


// get type of product service
exports.getProductTypeService = async (req) => {
  const type = req.params.type;
  const query = req.query;
  let products;
  if (query.new === "true") {
    products = await Product.find({ productType: type })
      .sort({ createdAt: -1 })
      .limit(8)
      .populate("reviews");
  } else if (query.featured === "true") {
    products = await Product.find({
      productType: type,
      featured: true,
    }).populate("reviews");
  } else if (query.topSellers === "true") {
    products = await Product.find({ productType: type })
      .sort({ sellCount: -1 })
      .limit(8)
      .populate("reviews");
  } else {
    products = await Product.find({ productType: type }).populate("reviews");
  }
  return products;
};

// get offer product service
exports.getOfferTimerProductService = async (query) => {
  const products = await Product.find({
    productType: query,
    "offerDate.endDate": { $gt: new Date() },
  }).populate("reviews");
  return products;
};

// get popular product service by type
exports.getPopularProductServiceByType = async (type) => {
  const products = await Product.find({ productType: type })
    .sort({ "reviews.length": -1 })
    .limit(8)
    .populate("reviews");
  return products;
};

exports.getTopRatedProductService = async () => {
  const products = await Product.find({
    reviews: { $exists: true, $ne: [] },
  }).populate("reviews");

  const topRatedProducts = products.map((product) => {
    const totalRating = product.reviews.reduce(
      (sum, review) => sum + review.rating,
      0
    );
    const averageRating = totalRating / product.reviews.length;

    return {
      ...product.toObject(),
      rating: averageRating,
    };
  });

  topRatedProducts.sort((a, b) => b.rating - a.rating);

  return topRatedProducts;
};

// get product by ObjectId OR slug
exports.getProductService = async (idOrSlug) => {
  const populateOpts = [
    {
      path: "reviews",
      populate: { path: "userId", select: "name email imageURL" },
    },
    "sizeGuide",
  ];

  let product = null;
  const isObjId =
    mongoose.Types.ObjectId.isValid(idOrSlug) &&
    String(new mongoose.Types.ObjectId(idOrSlug)) === String(idOrSlug);

  if (isObjId) {
    product = await Product.findById(idOrSlug).populate(populateOpts);
  }
  if (!product) {
    product = await Product.findOne({ slug: idOrSlug }).populate(populateOpts);
  }
  if (!product) {
    product = await Product.findOne({
      slug: new RegExp(`^${String(idOrSlug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    }).populate(populateOpts);
  }

  // Match slugified title for older products without slug saved yet
  if (!product) {
    const titleGuess = String(idOrSlug).replace(/-/g, " ").trim();
    product = await Product.findOne({
      title: new RegExp(
        `^${titleGuess.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i"
      ),
    }).populate(populateOpts);
  }

  // Backfill slug for older products
  if (product && !product.slug && product.title) {
    product.slug = await ensureUniqueSlug(slugify(product.title), product._id);
    await product.save();
  }

  return product;
};

// get product data
exports.getRelatedProductService = async (productId) => {
  const currentProduct = await Product.findById(productId);

  const relatedProducts = await Product.find({
    "category.name": currentProduct.category.name,
    _id: { $ne: productId }, // Exclude the current product ID
  });
  return relatedProducts;
};

// update a product
exports.updateProductService = async (id, currProduct) => {
  const product = await Product.findById(id);
  if (product) {
    product.title = currProduct.title;
    product.brand.name = currProduct.brand.name;
    product.brand.id = currProduct.brand.id;
    product.category.name = currProduct.category.name;
    product.category.id = currProduct.category.id;
    product.sku = currProduct.sku;
    product.img = currProduct.img;
    const nextSlug = currProduct.slug || slugify(currProduct.title);
    product.slug = await ensureUniqueSlug(nextSlug, product._id);
    product.unit = currProduct.unit;
    product.imageURLs = currProduct.imageURLs;
    product.tags = currProduct.tags;
    product.parent = currProduct.parent;
    product.children = currProduct.children;
    product.price = currProduct.price;
    product.featured = !!currProduct.featured;
    product.newArrival = !!currProduct.newArrival;
    product.bestSeller = !!currProduct.bestSeller;
    product.discount = currProduct.discount;
    product.quantity = currProduct.quantity;
    product.status = currProduct.status;
    product.productType = currProduct.productType;
    product.description = currProduct.description;
    product.productHighlights = currProduct.productHighlights || "";
    product.fabricCare = currProduct.fabricCare || "";
    product.additionalInformation = currProduct.additionalInformation;
    product.sizes = currProduct.sizes || [];
    product.sizeGuide = currProduct.sizeGuide || null;
    product.offerDate.startDate = currProduct.offerDate.startDate;
    product.offerDate.endDate = currProduct.offerDate.endDate;

    await product.save();
  }

  return product;
};


exports.getNewArrivalProducts = async () => {
  const result = await Product.find({
    $or: [{ newArrival: true }, { tags: "new-arrival" }],
  })
    .select("title discount price status tags imageURLs sellCount newArrival createdAt")
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  return result;
};

/**
 * Best Sellers:
 * 1) Admin checkbox (bestSeller: true)
 * 2) Else if orders exist → by sellCount
 * 3) Else (starting) → latest products so section still shows
 */
exports.getBestSellerProducts = async () => {
  const fields =
    "title discount price status tags imageURLs sellCount newArrival createdAt";

  const adminSelected = await Product.find({ bestSeller: true })
    .select(fields)
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  if (adminSelected.length > 0) return adminSelected;

  const Order = require("../model/Order");
  const totalOrders = await Order.countDocuments();

  if (totalOrders > 0) {
    const auto = await Product.find({ sellCount: { $gt: 0 } })
      .select(fields)
      .sort({ sellCount: -1 })
      .limit(8)
      .lean();
    if (auto.length > 0) return auto;
  }

  // Starting fallback — show latest products until admin marks Best Sellers
  const fallback = await Product.find({})
    .select(fields)
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  return fallback;
};


// get Reviews Products
exports.getReviewsProducts = async () => {
  const result = await Product.find({
    reviews: { $exists: true, $ne: [] },
  })
    .populate({
      path: "reviews",
      populate: { path: "userId", select: "name email imageURL" },
    });

  const products = result.filter(p => p.reviews.length > 0)

  return products;
};

// get Reviews Products
exports.getStockOutProducts = async () => {
  const result = await Product.find({ status: "out-of-stock" }).sort({ createdAt: -1 })
  return result;
};

// get Reviews Products
// exports.deleteProduct = async (id) => {
//   const result = await Product.findByIdAndDelete(id)
//   return result;
// };


// Delete product with images
exports.deleteProduct = async (id) => {
  try {
    // First, find the product to get image URLs
    const product = await Product.findById(id);
    
    if (!product) {
      throw new Error('Product not found');
    }

    // Extract all image URLs from product
    const imagePublicIds = [];
    
    if (product.imageURLs && Array.isArray(product.imageURLs)) {
      product.imageURLs.forEach((imgObj) => {
        if (imgObj.img && typeof imgObj.img === 'string') {
          // Check if it's a Cloudinary URL
          if (imgObj.img.includes('cloudinary.com')) {
            const publicId = extractPublicId(imgObj.img);
            if (publicId) {
              imagePublicIds.push(publicId);
            }
          }
        }
      });
    }

    console.log(`Found ${imagePublicIds.length} images to delete for product ${id}`);

    // Delete images from Cloudinary (in parallel)
    if (imagePublicIds.length > 0) {
      const deletionPromises = imagePublicIds.map(publicId => 
        cloudinaryServices.cloudinaryImageDelete(publicId)
          .catch(err => {
            console.error(`Failed to delete image ${publicId}:`, err);
            return { result: 'error', publicId, error: err.message };
          })
      );

      const deletionResults = await Promise.all(deletionPromises);
      
      const successCount = deletionResults.filter(r => r.result === 'ok').length;
      console.log(`Successfully deleted ${successCount}/${imagePublicIds.length} images from Cloudinary`);
    }

    // Delete the product from database
    const result = await Product.findByIdAndDelete(id);
    
    return result;
  } catch (error) {
    console.error('Error in deleteProduct service:', error);
    throw error;
  }
};



// Helper function to extract public_id from Cloudinary URL
const extractPublicId = (imageUrl) => {
  try {
    // Match pattern: /upload/v{version}/{public_id}.{extension}
    const regex = /\/upload\/(?:v\d+\/)?([^/.]+(?:\/[^/.]+)*)/;
    const matches = imageUrl.match(regex);
    
    if (matches && matches[1]) {
      return matches[1];
    }
    return null;
  } catch (error) {
    console.error('Error extracting public_id from URL:', imageUrl, error);
    return null;
  }
};