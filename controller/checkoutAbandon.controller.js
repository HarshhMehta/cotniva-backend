const CheckoutAbandon = require("../model/CheckoutAbandon");

exports.createAbandonFeedback = async (req, res, next) => {
  try {
    const {
      reasons = [],
      stillCancel = true,
      page = "checkout",
      phone,
      email,
      userId,
      cartTotal,
      cartCount,
      cartSnapshot,
    } = req.body || {};

    const cleanReasons = (Array.isArray(reasons) ? reasons : [])
      .map((r) => String(r || "").trim())
      .filter(Boolean)
      .slice(0, 8);

    if (cleanReasons.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please select at least one reason",
      });
    }

    const doc = await CheckoutAbandon.create({
      reasons: cleanReasons,
      stillCancel: Boolean(stillCancel),
      page: String(page || "checkout").slice(0, 40),
      phone: phone ? String(phone).slice(0, 20) : undefined,
      email: email ? String(email).slice(0, 120) : undefined,
      userId: userId || null,
      cartTotal: Number(cartTotal) || 0,
      cartCount: Number(cartCount) || 0,
      cartSnapshot: Array.isArray(cartSnapshot)
        ? cartSnapshot.slice(0, 20)
        : [],
      userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    });

    res.status(201).json({
      success: true,
      message: "Feedback saved",
      data: { id: doc._id },
    });
  } catch (error) {
    next(error);
  }
};

exports.listAbandonFeedback = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const skip = (page - 1) * limit;

    const [items, total, reasonAgg] = await Promise.all([
      CheckoutAbandon.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CheckoutAbandon.countDocuments(),
      CheckoutAbandon.aggregate([
        { $unwind: "$reasons" },
        { $group: { _id: "$reasons", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        items,
        total,
        page,
        pages: Math.ceil(total / limit) || 1,
        reasonStats: reasonAgg.map((r) => ({
          reason: r._id,
          count: r.count,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};
