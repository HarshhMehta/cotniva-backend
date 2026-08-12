const Order = require("../model/Order");
const User = require("../model/User");
const CustomerActivity = require("../model/CustomerActivity");

/**
 * Admin customer list — search, sort, pagination + order aggregates.
 */
exports.getCustomers = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const sortKey = String(req.query.sort || "createdAt_desc");
    const status = String(req.query.status || "").trim();

    const filter = { role: { $ne: "admin" } };
    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { name: rx },
        { email: rx },
        { phone: rx },
        { contactNumber: rx },
      ];
    }

    const sortMap = {
      createdAt_desc: { createdAt: -1 },
      createdAt_asc: { createdAt: 1 },
      name_asc: { name: 1 },
      name_desc: { name: -1 },
      lastLogin_desc: { lastLogin: -1 },
      lastOrder_desc: { lastOrderAt: -1 },
    };
    const sort = sortMap[sortKey] || sortMap.createdAt_desc;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("-password -confirmationToken -passwordResetToken")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const ids = users.map((u) => u._id);
    const orderStats = await Order.aggregate([
      { $match: { user: { $in: ids } } },
      {
        $group: {
          _id: "$user",
          totalOrders: { $sum: 1 },
          totalSpend: { $sum: { $ifNull: ["$totalAmount", 0] } },
          lastOrderAt: { $max: "$createdAt" },
        },
      },
    ]);
    const statsByUser = Object.fromEntries(
      orderStats.map((s) => [String(s._id), s])
    );

    const data = users.map((u) => {
      const s = statsByUser[String(u._id)] || {};
      return {
        ...u,
        phone: u.phone || u.contactNumber || "",
        registrationDate: u.registeredAt || u.createdAt,
        totalOrders: s.totalOrders || 0,
        totalSpend: s.totalSpend || 0,
        lastOrder: s.lastOrderAt || u.lastOrderAt || null,
        lastLogin: u.lastLogin || null,
      };
    });

    // Optional client-side spend sort (aggregate not in User)
    if (sortKey === "spend_desc") {
      data.sort((a, b) => (b.totalSpend || 0) - (a.totalSpend || 0));
    } else if (sortKey === "orders_desc") {
      data.sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0));
    }

    res.status(200).json({
      success: true,
      data,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getCustomerById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select("-password -confirmationToken -passwordResetToken")
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const orders = await Order.find({ user: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const spendAgg = await Order.aggregate([
      { $match: { user: user._id } },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalSpend: { $sum: { $ifNull: ["$totalAmount", 0] } },
        },
      },
    ]);

    const addressesFromOrders = [];
    const seen = new Set();
    for (const o of orders) {
      const key = `${o.address}|${o.city}|${o.zipCode}`;
      if (!o.address || seen.has(key)) continue;
      seen.add(key);
      addressesFromOrders.push({
        name: o.name,
        address: o.address,
        city: o.city,
        zipCode: o.zipCode,
        country: o.country,
        contact: o.contact,
        email: o.email,
        source: "order",
      });
    }

    const saved = (user.savedAddresses || []).map((a) => ({
      ...a,
      source: "saved",
    }));

    res.status(200).json({
      success: true,
      data: {
        ...user,
        phone: user.phone || user.contactNumber || "",
        registrationDate: user.registeredAt || user.createdAt,
        totalOrders: spendAgg[0]?.totalOrders || 0,
        lifetimeSpend: spendAgg[0]?.totalSpend || 0,
        savedAddresses: [...saved, ...addressesFromOrders],
        recentOrders: orders,
        currentCart: user.currentCart || null,
        wishlistCount: user.wishlistCount || 0,
        lastLogin: user.lastLogin || null,
        lastOrderAt: user.lastOrderAt || null,
        cartUpdatedAt: user.cartUpdatedAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getCustomerActivity = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const items = await CustomerActivity.find({ user: req.params.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.status(200).json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

/** Front-end cart beacon — stores cart snapshot + timestamp. */
exports.syncCartActivity = async (req, res, next) => {
  try {
    const userId = req.body.userId || req.params.id;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId required" });
    }
    const cart = req.body.cart || null;
    const { trackCustomerActivity } = require("../services/customer-activity.service");
    await trackCustomerActivity(userId, "cart_updated", { cart });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.updateCustomerStatus = async (req, res, next) => {
  try {
    const status = req.body.status;
    if (!["active", "inactive", "blocked"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    ).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};
