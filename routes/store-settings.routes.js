const express = require('express');
const router = express.Router();
const storeSettingsController = require('../controller/store-settings.controller');

router.get('/', storeSettingsController.getStoreSettings);
router.patch('/update', storeSettingsController.updateStoreSettings);

module.exports = router;
