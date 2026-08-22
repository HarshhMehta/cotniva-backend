const ApiError = require('../errors/api-error');
const Category = require('../model/Category');
const Products = require('../model/Products');

// create category service
exports.createCategoryService = async (data) => {
  const category = await Category.create(data);
  return category;
}

// create all category service
exports.addAllCategoryService = async (data) => {
  await Category.deleteMany()
  const category = await Category.insertMany(data);
  return category;
}

// get all show category service — metadata only (no product populate)
exports.getShowCategoryServices = async () => {
  const categories = await Category.find({ status: "Show" })
    .select("parent img children productType status products")
    .sort({ parent: 1 })
    .lean();
  return categories.map((cat) => ({
    ...cat,
    productCount: Array.isArray(cat.products) ? cat.products.length : 0,
  }));
}

// get all category 
exports.getAllCategoryServices = async () => {
  const category = await Category.find({})
  return category;
}

// get type of category service — no product populate
exports.getCategoryTypeService = async (param) => {
  const categories = await Category.find({ productType: param })
    .select("parent img children productType status products")
    .sort({ parent: 1 })
    .lean();
  return categories.map((cat) => ({
    ...cat,
    productCount: Array.isArray(cat.products) ? cat.products.length : 0,
  }));
}

// get type of category service
exports.deleteCategoryService = async (id) => {
  const result = await Category.findByIdAndDelete(id);
  return result;
}

// update category
exports.updateCategoryService = async (id,payload) => {
  const isExist = await Category.findOne({ _id:id })

  if (!isExist) {
    throw new ApiError(404, 'Category not found !')
  }

  const result = await Category.findOneAndUpdate({ _id:id }, payload, {
    new: true,
  })

  const nextParent = String(payload?.parent || '').trim()
  if (nextParent && nextParent !== isExist.parent) {
    await Products.updateMany(
      { 'category.id': isExist._id },
      {
        $set: {
          'category.name': nextParent,
          parent: nextParent,
        },
      }
    )
  }

  return result
}

// get single category
exports.getSingleCategoryService = async (id) => {
  const result = await Category.findById(id);
  return result;
}