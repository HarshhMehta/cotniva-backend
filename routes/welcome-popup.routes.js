const express = require('express');
const router = express.Router();
const welcomePopupController = require('../controller/welcome-popup.controller');

router.get('/', welcomePopupController.getWelcomePopup);
router.patch('/update', welcomePopupController.updateWelcomePopup);

module.exports = router;
