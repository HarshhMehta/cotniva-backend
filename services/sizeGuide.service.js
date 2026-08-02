const SizeGuide = require("../model/SizeGuide");

exports.createSizeGuide = async (data) => {
  return SizeGuide.create(data);
};

exports.getAllSizeGuides = async () => {
  return SizeGuide.find({}).sort({ createdAt: -1 }).lean();
};

exports.getShowSizeGuides = async () => {
  return SizeGuide.find({ status: "Show" }).sort({ title: 1 }).lean();
};

exports.getSizeGuideById = async (id) => {
  return SizeGuide.findById(id).lean();
};

exports.updateSizeGuide = async (id, data) => {
  return SizeGuide.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });
};

exports.deleteSizeGuide = async (id) => {
  return SizeGuide.findByIdAndDelete(id);
};
