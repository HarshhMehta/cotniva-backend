const User = require("../model/User");

const MAX_ADDRESSES = 12;

const normalizePhone = (raw = "") => {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("91") && d.length >= 12) d = d.slice(-10);
  else if (d.startsWith("0") && d.length >= 11) d = d.replace(/^0+/, "");
  else if (d.length > 10) d = d.slice(-10);
  if (d.startsWith("0") && d.length === 10) d = d.slice(1);
  return d.slice(0, 10);
};

const normalize = (raw = {}) => ({
  firstName: String(raw.firstName || "").trim(),
  lastName: String(raw.lastName || "").trim(),
  address: String(raw.address || "").trim(),
  city: String(raw.city || "").trim(),
  zipCode: String(raw.zipCode || "").replace(/\D/g, "").slice(0, 6),
  country: String(raw.country || "India").trim() || "India",
  contactNo: normalizePhone(raw.contactNo),
  email: String(raw.email || "").trim().toLowerCase(),
  label: String(raw.label || "").trim(),
  orderNote: String(raw.orderNote || "").trim(),
  isDefault: Boolean(raw.isDefault),
});

const toPublic = (doc) => {
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  return {
    id: String(o._id),
    firstName: o.firstName || "",
    lastName: o.lastName || "",
    address: o.address || "",
    city: o.city || "",
    zipCode: o.zipCode || "",
    country: o.country || "India",
    contactNo: o.contactNo || "",
    email: o.email || "",
    label: o.label || "",
    orderNote: o.orderNote || "",
    isDefault: Boolean(o.isDefault),
  };
};

const addressKey = (a) =>
  `${String(a.address || "").trim().toLowerCase()}|${String(a.zipCode || "").replace(/\D/g, "")}|${String(a.contactNo || "").replace(/\D/g, "").slice(-10)}`;

const listPublic = (user) =>
  (user.savedAddresses || []).map((a) => toPublic(a));

const ensureDefault = (list) => {
  if (!list.length) return list;
  if (list.some((a) => a.isDefault)) return list;
  list[0].isDefault = true;
  return list;
};

const userIdFromReq = (req) => req.user?._id || req.user?.id;

exports.list = async (req, res, next) => {
  try {
    const user = await User.findById(userIdFromReq(req)).select("savedAddresses");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    res.status(200).json({ success: true, data: { addresses: listPublic(user) } });
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const user = await User.findById(userIdFromReq(req));
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if ((user.savedAddresses || []).length >= MAX_ADDRESSES) {
      return res.status(400).json({
        success: false,
        message: `You can save up to ${MAX_ADDRESSES} addresses.`,
      });
    }
    const payload = normalize(req.body);
    if (!payload.firstName || !payload.address) {
      return res.status(400).json({
        success: false,
        message: "First name and address are required",
      });
    }
    const makeDefault =
      payload.isDefault || (user.savedAddresses || []).length === 0;
    if (makeDefault) {
      user.savedAddresses.forEach((a) => {
        a.isDefault = false;
      });
    }
    user.savedAddresses.push({ ...payload, isDefault: makeDefault });
    await user.save();
    const created = user.savedAddresses[user.savedAddresses.length - 1];
    res.status(201).json({
      success: true,
      data: { address: toPublic(created), addresses: listPublic(user) },
    });
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const user = await User.findById(userIdFromReq(req));
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const entry = user.savedAddresses.id(req.params.addrId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }
    const payload = normalize({ ...toPublic(entry), ...req.body });
    Object.assign(entry, payload, { isDefault: entry.isDefault });
    if (req.body.isDefault === true) {
      user.savedAddresses.forEach((a) => {
        a.isDefault = String(a._id) === String(entry._id);
      });
    }
    ensureDefault(user.savedAddresses);
    await user.save();
    res.status(200).json({
      success: true,
      data: { address: toPublic(entry), addresses: listPublic(user) },
    });
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const user = await User.findById(userIdFromReq(req));
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!user.savedAddresses.id(req.params.addrId)) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }
    user.savedAddresses.pull(req.params.addrId);
    ensureDefault(user.savedAddresses);
    await user.save();
    res.status(200).json({
      success: true,
      data: { addresses: listPublic(user) },
    });
  } catch (error) {
    next(error);
  }
};

exports.setDefault = async (req, res, next) => {
  try {
    const user = await User.findById(userIdFromReq(req));
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const entry = user.savedAddresses.id(req.params.addrId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }
    user.savedAddresses.forEach((a) => {
      a.isDefault = String(a._id) === String(entry._id);
    });
    await user.save();
    res.status(200).json({
      success: true,
      data: { addresses: listPublic(user) },
    });
  } catch (error) {
    next(error);
  }
};

/** One-shot migrate from device localStorage */
exports.importMany = async (req, res, next) => {
  try {
    const user = await User.findById(userIdFromReq(req));
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const incoming = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    const existingKeys = new Set(
      (user.savedAddresses || []).map((a) => addressKey(a))
    );
    for (const raw of incoming) {
      if ((user.savedAddresses || []).length >= MAX_ADDRESSES) break;
      const payload = normalize(raw);
      if (!payload.firstName || !payload.address) continue;
      const key = addressKey(payload);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const makeDefault =
        payload.isDefault || user.savedAddresses.length === 0;
      if (makeDefault) {
        user.savedAddresses.forEach((a) => {
          a.isDefault = false;
        });
      }
      user.savedAddresses.push({ ...payload, isDefault: makeDefault });
    }
    ensureDefault(user.savedAddresses);
    await user.save();
    res.status(200).json({
      success: true,
      data: { addresses: listPublic(user) },
    });
  } catch (error) {
    next(error);
  }
};
