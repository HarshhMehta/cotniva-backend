const express = require('express');
const router = express.Router();
const { bindPatchOrPost } = require('../utils/patch-or-post');
const patchOrPost = bindPatchOrPost(router);
const storeSettingsController = require('../controller/store-settings.controller');
const { requireAdmin } = require('../config/auth');

router.get('/', storeSettingsController.getStoreSettings);
patchOrPost('/update', requireAdmin, storeSettingsController.updateStoreSettings);

module.exports = router;
