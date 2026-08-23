const express = require('express');
const router = express.Router();
const { bindPatchOrPost } = require('../utils/patch-or-post');
const patchOrPost = bindPatchOrPost(router);
const welcomePopupController = require('../controller/welcome-popup.controller');
const { requireAdmin } = require('../config/auth');


router.get('/', welcomePopupController.getWelcomePopup);
patchOrPost('/update', requireAdmin, welcomePopupController.updateWelcomePopup);

module.exports = router;
