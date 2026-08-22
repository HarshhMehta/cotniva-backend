const express = require('express');
const router = express.Router();
const storeSettingsController = require('../controller/store-settings.controller');
const { requireAdmin } = require('../config/auth');

router.get('/', storeSettingsController.getStoreSettings);
router.patch('/update', requireAdmin, storeSettingsController.updateStoreSettings);

module.exports = router;
