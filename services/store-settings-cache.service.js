const StoreSettings = require("../model/StoreSettings");

const TTL_MS = 45_000;

const DEFAULTS = {
  deliveryCharge: 100,
  freeShippingAbove: 1299,
};

let cached = null;
let expiresAt = 0;

const invalidateStoreSettingsCache = () => {
  cached = null;
  expiresAt = 0;
};

const getStoreSettingsDocument = async () => {
  const now = Date.now();
  if (cached && now < expiresAt) {
    return cached;
  }

  let settings = await StoreSettings.findOne().lean();
  if (!settings) {
    settings = await StoreSettings.create(DEFAULTS);
    settings =
      typeof settings.toObject === "function"
        ? settings.toObject()
        : { ...settings };
  }

  cached = settings;
  expiresAt = now + TTL_MS;
  return settings;
};

const getShippingSettings = async () => {
  const settings = await getStoreSettingsDocument();
  return {
    deliveryCharge:
      settings?.deliveryCharge != null
        ? Number(settings.deliveryCharge)
        : DEFAULTS.deliveryCharge,
    freeShippingAbove:
      settings?.freeShippingAbove != null
        ? Number(settings.freeShippingAbove)
        : DEFAULTS.freeShippingAbove,
  };
};

module.exports = {
  DEFAULTS,
  invalidateStoreSettingsCache,
  getStoreSettingsDocument,
  getShippingSettings,
};
