const TopBar = require('../model/TopBar');

// get topbar
exports.getTopBar = async (req, res, next) => {
  try {
    let topbar = await TopBar.findOne();
    if (!topbar) {
      topbar = await TopBar.create({});
    }
    res.status(200).json({ success: true, data: topbar });
  } catch (error) {
    next(error);
  }
};

// update topbar
exports.updateTopBar = async (req, res, next) => {
  try {
    let topbar = await TopBar.findOne();
    if (!topbar) {
      topbar = await TopBar.create(req.body);
    } else {
      topbar.text = req.body.text ?? topbar.text;
      topbar.isActive = req.body.isActive ?? topbar.isActive;
      topbar.bgColor = req.body.bgColor ?? topbar.bgColor;
      topbar.textColor = req.body.textColor ?? topbar.textColor;
      await topbar.save();
    }
    res.status(200).json({ success: true, data: topbar });
  } catch (error) {
    next(error);
  }
};