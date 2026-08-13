const mongoose = require('mongoose');

const storeSettingsSchema = mongoose.Schema(
  {
    deliveryCharge: {
      type: Number,
      default: 100,
      min: 0,
    },
    freeShippingAbove: {
      type: Number,
      default: 1299,
      min: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StoreSettings', storeSettingsSchema);
