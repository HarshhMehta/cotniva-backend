const StoreSettings = require('../model/StoreSettings');

const defaults = {
  deliveryCharge: 100,
  freeShippingAbove: 1299,
};

exports.getStoreSettings = async (req, res, next) => {
  try {
    let settings = await StoreSettings.findOne();
    if (!settings) {
      settings = await StoreSettings.create(defaults);
    }
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
};

exports.updateStoreSettings = async (req, res, next) => {
  try {
    const deliveryCharge = Number(req.body.deliveryCharge);
    const freeShippingAbove = Number(req.body.freeShippingAbove);

    if (Number.isNaN(deliveryCharge) || deliveryCharge < 0) {
      return res.status(400).json({
        success: false,
        message: 'deliveryCharge must be a number ≥ 0',
      });
    }
    if (Number.isNaN(freeShippingAbove) || freeShippingAbove < 0) {
      return res.status(400).json({
        success: false,
        message: 'freeShippingAbove must be a number ≥ 0',
      });
    }

    let settings = await StoreSettings.findOne();
    if (!settings) {
      settings = await StoreSettings.create({
        deliveryCharge,
        freeShippingAbove,
      });
    } else {
      settings.deliveryCharge = deliveryCharge;
      settings.freeShippingAbove = freeShippingAbove;
      await settings.save();
    }

    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
};
