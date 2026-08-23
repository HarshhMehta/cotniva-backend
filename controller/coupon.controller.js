const Coupon = require('../model/Coupon');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const normalizeCategories = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((id) => String(id || '').trim())
    .filter(Boolean);
};

const parseNumberInput = (raw) => {
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw ?? '')
    .replace(/%/g, '')
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();
  if (!cleaned) return NaN;
  return Number(cleaned);
};

const buildCouponPayload = (body = {}) => {
  const neverExpires = Boolean(body.neverExpires);
  let endTime = null;
  if (!neverExpires && body.endTime) {
    const parsed = dayjs(body.endTime);
    endTime = parsed.isValid() ? parsed.toDate() : null;
  }

  const discountType =
    String(body.discountType || "percentage").toLowerCase() === "fixed"
      ? "fixed"
      : "percentage";

  const discountValue = parseNumberInput(
    body.discountValue != null ? body.discountValue : body.discountPercentage
  );

  let maxUses = null;
  if (body.maxUses !== undefined && body.maxUses !== null && body.maxUses !== "") {
    const n = parseNumberInput(body.maxUses);
    if (Number.isFinite(n) && n > 0) maxUses = Math.floor(n);
  }

  let maxUsesPerUser = null;
  if (
    body.maxUsesPerUser !== undefined &&
    body.maxUsesPerUser !== null &&
    body.maxUsesPerUser !== ""
  ) {
    const n = parseNumberInput(body.maxUsesPerUser);
    if (Number.isFinite(n) && n > 0) maxUsesPerUser = Math.floor(n);
  }

  return {
    title: body.title,
    logo: body.logo || "",
    couponCode: String(body.couponCode || "").trim().toUpperCase(),
    discountType,
    discountPercentage:
      discountType === "percentage"
        ? discountValue
        : parseNumberInput(body.discountPercentage) || 0,
    discountAmount:
      discountType === "fixed"
        ? discountValue
        : parseNumberInput(body.discountAmount) || 0,
    minimumAmount: parseNumberInput(body.minimumAmount) || 0,
    maxUses,
    maxUsesPerUser,
    neverExpires,
    endTime,
    productType: body.productType || "all",
    applicableCategories: normalizeCategories(body.applicableCategories),
    status: body.status || "active",
  };
};

// addCoupon
const addCoupon = async (req, res, next) => {
  try {
    const payload = buildCouponPayload(req.body);
    if (!payload.title || !payload.couponCode) {
      return res.status(400).json({ message: 'Title and coupon code are required' });
    }
    if (payload.discountType === "fixed") {
      if (!Number.isFinite(payload.discountAmount) || payload.discountAmount <= 0) {
        return res.status(400).json({ message: "Discount amount (₹) must be greater than 0" });
      }
    } else if (!Number.isFinite(payload.discountPercentage) || payload.discountPercentage <= 0) {
      return res.status(400).json({ message: "Discount percentage must be greater than 0" });
    }
    if (!payload.neverExpires && !payload.endTime) {
      return res.status(400).json({ message: "End date is required unless Never Expire is selected" });
    }

    const newCoupon = new Coupon(payload);
    if (!newCoupon.startTime) {
      newCoupon.startTime = new Date();
    }
    await newCoupon.save();
    res.send({ message: 'Coupon Added Successfully!', data: newCoupon });
  } catch (error) {
    next(error);
  }
};

// addAllCoupon
const addAllCoupon = async (req, res, next) => {
  try {
    await Coupon.deleteMany();
    await Coupon.insertMany(req.body);
    res.status(200).send({
      message: 'Coupon Added successfully!',
    });
  } catch (error) {
    next(error);
  }
};

// getAllCoupons
const getAllCoupons = async (req, res, next) => {
  try {
    const coupons = await Coupon.find({})
      .populate('applicableCategories', 'parent img status')
      .sort({ _id: -1 });
    res.send(coupons);
  } catch (error) {
    next(error);
  }
};

// getCouponById
const getCouponById = async (req, res, next) => {
  try {
    const coupon = await Coupon.findById(req.params.id).populate(
      'applicableCategories',
      'parent img status'
    );
    res.send(coupon);
  } catch (error) {
    next(error);
  }
};

// updateCoupon
const updateCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }

    const payload = buildCouponPayload(req.body);
    if (!payload.neverExpires && !payload.endTime) {
      return res.status(400).json({ message: 'End date is required unless Never Expire is selected' });
    }
    if (payload.discountType === "fixed") {
      if (!Number.isFinite(payload.discountAmount) || payload.discountAmount <= 0) {
        return res.status(400).json({ message: "Discount amount (₹) must be greater than 0" });
      }
    } else if (!Number.isFinite(payload.discountPercentage) || payload.discountPercentage <= 0) {
      return res.status(400).json({ message: "Discount percentage must be greater than 0" });
    }

    coupon.title = payload.title;
    coupon.couponCode = payload.couponCode;
    coupon.discountType = payload.discountType;
    coupon.discountPercentage = payload.discountPercentage;
    coupon.discountAmount = payload.discountAmount;
    coupon.minimumAmount = payload.minimumAmount;
    coupon.maxUses = payload.maxUses;
    coupon.maxUsesPerUser = payload.maxUsesPerUser;
    coupon.productType = payload.productType;
    coupon.logo = payload.logo;
    coupon.neverExpires = payload.neverExpires;
    coupon.endTime = payload.endTime;
    coupon.applicableCategories = payload.applicableCategories;
    if (req.body.status) coupon.status = req.body.status;

    await coupon.save();
    res.send({ message: 'Coupon Updated Successfully!' });
  } catch (error) {
    next(error);
  }
};

// deleteCoupon
const deleteCoupon = async (req, res, next) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    res.status(200).json({
      success: true,
      message: 'Coupon delete successfully',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addCoupon,
  addAllCoupon,
  getAllCoupons,
  getCouponById,
  updateCoupon,
  deleteCoupon,
};
