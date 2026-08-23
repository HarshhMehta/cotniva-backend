const express = require('express');
const router = express.Router();
const { bindPatchOrPost } = require('../utils/patch-or-post');
const patchOrPost = bindPatchOrPost(router);
const {
  addCoupon,
  addAllCoupon,
  getAllCoupons,
  getCouponById,
  updateCoupon,
  deleteCoupon,
} = require('../controller/coupon.controller');
const { requireAdmin } = require('../config/auth');

router.post('/add', requireAdmin, addCoupon);
router.post('/all', requireAdmin, addAllCoupon);
router.get('/', getAllCoupons);
router.get('/:id', getCouponById);
patchOrPost('/:id', requireAdmin, updateCoupon);
router.delete('/:id', requireAdmin, deleteCoupon);

module.exports = router;
