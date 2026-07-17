const express = require('express');
const router = express.Router();
const topbarController = require('../controller/topbar.controller');

router.get('/', topbarController.getTopBar);
router.patch('/update', topbarController.updateTopBar);

module.exports = router;