const express = require('express');
const router = express.Router();
const welcomePopupController = require('../controller/welcome-popup.controller');
const { requireAdmin } = require('../config/auth');

router.get('/', welcomePopupController.getWelcomePopup);
router.patch('/update', requireAdmin, welcomePopupController.updateWelcomePopup);

module.exports = router;
