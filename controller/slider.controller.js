const Slider = require('../model/Slider');

exports.addSlider = async (req, res, next) => {
  try {
    const result = await Slider.create(req.body);
    res.status(200).json({ status: "success", message: "Slider created successfully!", data: result });
  } catch (error) { next(error); }
};

exports.getAllSliders = async (req, res, next) => {
  try {
    const result = await Slider.find({}).sort({ order: 1 });
    res.status(200).json({ success: true, result });
  } catch (error) { next(error); }
};

exports.getActiveSliders = async (req, res, next) => {
  try {
    const result = await Slider.find({ status: "active" }).sort({ order: 1 });
    res.status(200).json({ success: true, result });
  } catch (error) { next(error); }
};

exports.getSingleSlider = async (req, res, next) => {
  try {
    const result = await Slider.findById(req.params.id);
    res.status(200).json(result);
  } catch (error) { next(error); }
};

exports.updateSlider = async (req, res, next) => {
  try {
    const result = await Slider.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.status(200).json({ status: true, message: "Slider updated successfully", data: result });
  } catch (error) { next(error); }
};

exports.deleteSlider = async (req, res, next) => {
  try {
    await Slider.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: "Slider deleted successfully" });
  } catch (error) { next(error); }
};
