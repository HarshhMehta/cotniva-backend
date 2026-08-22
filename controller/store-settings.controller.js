const StoreSettings = require('../model/StoreSettings');
const {
  getStoreSettingsDocument,
  invalidateStoreSettingsCache,
} = require('../services/store-settings-cache.service');
const { setPublicCache, PUBLIC_SETTINGS_CACHE } = require('../utils/public-cache');

exports.getStoreSettings = async (req, res, next) => {
  try {
    const settings = await getStoreSettingsDocument();
    setPublicCache(res, PUBLIC_SETTINGS_CACHE);
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

    invalidateStoreSettingsCache();

    res.status(200).json({
      success: true,
      data:
        typeof settings.toObject === 'function'
          ? settings.toObject()
          : settings,
    });
  } catch (error) {
    next(error);
  }
};
