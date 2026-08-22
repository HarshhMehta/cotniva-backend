const express = require('express');
const router = express.Router();
const userOrderController = require('../controller/user.order.controller');
const verifyToken = require('../middleware/verifyToken');
const { requireAdmin } = require('../config/auth');

// Admin dashboards
router.get('/dashboard-amount', requireAdmin, userOrderController.getDashboardAmount);
router.get('/sales-report', requireAdmin, userOrderController.getSalesReport);
router.get('/most-selling-category', requireAdmin, userOrderController.mostSellingCategory);
router.get('/dashboard-recent-order', requireAdmin, userOrderController.getDashboardRecentOrder);

// lookup after Razorpay redirect (must be before /:id)
router.get(
  '/by-razorpay/:razorpayOrderId',
  verifyToken,
  userOrderController.getOrderByRazorpayOrderId
);

//get a order by id (owner only)
router.get('/:id', verifyToken, userOrderController.getOrderById);

//get all order by a user
router.get('/', verifyToken, userOrderController.getOrderByUser);

module.exports = router;
