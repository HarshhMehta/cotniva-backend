const Notification = require("../model/Notification");
const {
  createNotification,
  notifyPaymentFailed,
} = require("../services/notification.service");

exports.getNotifications = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;
    const unreadOnly = String(req.query.unreadOnly || "") === "true";

    const filter = unreadOnly ? { isRead: false } : {};

    const [items, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ isRead: false }),
    ]);

    res.status(200).json({
      success: true,
      data: items,
      meta: {
        total,
        unreadCount,
        page,
        limit,
        hasMore: skip + items.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getUnreadCount = async (req, res, next) => {
  try {
    const unreadCount = await Notification.countDocuments({ isRead: false });
    res.status(200).json({ success: true, unreadCount });
  } catch (error) {
    next(error);
  }
};

exports.markAsRead = async (req, res, next) => {
  try {
    const doc = await Notification.findByIdAndUpdate(
      req.params.id,
      { $set: { isRead: true } },
      { new: true }
    );
    if (!doc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.status(200).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};

exports.markAllAsRead = async (req, res, next) => {
  try {
    const result = await Notification.updateMany(
      { isRead: false },
      { $set: { isRead: true } }
    );
    res.status(200).json({
      success: true,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    next(error);
  }
};

/** Optional client/webhook report for failed payments (no order created). */
exports.reportPaymentFailed = async (req, res, next) => {
  try {
    const { reason, amount, relatedCustomerId, meta } = req.body || {};
    const doc = await notifyPaymentFailed({
      reason,
      amount,
      relatedCustomerId,
      meta,
    });
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};

/** Future / manual create — keeps create path centralized. */
exports.createManualNotification = async (req, res, next) => {
  try {
    const doc = await createNotification(req.body || {});
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};
