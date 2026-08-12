const CustomerActivity = require("../model/CustomerActivity");
const User = require("../model/User");

/**
 * Append activity + keep denormalized timestamps on User for fast admin lists.
 */
const trackCustomerActivity = async (userId, type, meta = {}) => {
  if (!userId || !type) return null;

  const activity = await CustomerActivity.create({
    user: userId,
    type,
    meta,
  });

  const patch = {};
  const now = new Date();

  if (type === "login") patch.lastLogin = now;
  if (type === "registration") patch.registeredAt = now;
  if (type === "cart_updated") {
    patch.cartUpdatedAt = now;
    if (meta?.cart) patch.currentCart = meta.cart;
  }
  if (type === "order_placed") patch.lastOrderAt = now;

  if (Object.keys(patch).length) {
    await User.findByIdAndUpdate(userId, { $set: patch });
  }

  return activity;
};

module.exports = {
  trackCustomerActivity,
};
