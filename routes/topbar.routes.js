const express = require('express');
const router = express.Router();
const topbarController = require('../controller/topbar.controller');
const { requireAdmin } = require('../config/auth');

router.get('/', topbarController.getTopBar);
router.patch('/update', requireAdmin, topbarController.updateTopBar);

module.exports = router;
