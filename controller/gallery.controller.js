const Gallery = require("../model/Gallery");

exports.addGallery = async (req, res, next) => {
  try {
    const result = await Gallery.create(req.body);
    res.status(200).json({
      status: "success",
      message: "Gallery image added successfully!",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.getAllGallery = async (req, res, next) => {
  try {
    const result = await Gallery.find({}).sort({ order: 1, createdAt: -1 });
    res.status(200).json({ success: true, result });
  } catch (error) {
    next(error);
  }
};

exports.getActiveGallery = async (req, res, next) => {
  try {
    const result = await Gallery.find({ status: "active" }).sort({
      order: 1,
      createdAt: -1,
    });
    res.status(200).json({ success: true, result });
  } catch (error) {
    next(error);
  }
};

exports.getSingleGallery = async (req, res, next) => {
  try {
    const result = await Gallery.findById(req.params.id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.updateGallery = async (req, res, next) => {
  try {
    const result = await Gallery.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.status(200).json({
      status: true,
      message: "Gallery image updated successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteGallery = async (req, res, next) => {
  try {
    await Gallery.findByIdAndDelete(req.params.id);
    res.status(200).json({
      success: true,
      message: "Gallery image deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};
