const sizeGuideServices = require("../services/sizeGuide.service");

exports.addSizeGuide = async (req, res, next) => {
  try {
    const result = await sizeGuideServices.createSizeGuide(req.body);
    res.status(201).json({
      success: true,
      message: "Size guide created successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.getAllSizeGuides = async (req, res, next) => {
  try {
    const result = await sizeGuideServices.getAllSizeGuides();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getShowSizeGuides = async (req, res, next) => {
  try {
    const result = await sizeGuideServices.getShowSizeGuides();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getSizeGuide = async (req, res, next) => {
  try {
    const result = await sizeGuideServices.getSizeGuideById(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, message: "Size guide not found" });
    }
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.updateSizeGuide = async (req, res, next) => {
  try {
    const result = await sizeGuideServices.updateSizeGuide(req.params.id, req.body);
    if (!result) {
      return res.status(404).json({ success: false, message: "Size guide not found" });
    }
    res.status(200).json({
      success: true,
      message: "Size guide updated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteSizeGuide = async (req, res, next) => {
  try {
    const result = await sizeGuideServices.deleteSizeGuide(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, message: "Size guide not found" });
    }
    res.status(200).json({
      success: true,
      message: "Size guide deleted successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
