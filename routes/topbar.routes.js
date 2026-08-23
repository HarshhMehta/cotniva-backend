const express = require('express');
const router = express.Router();
const { bindPatchOrPost } = require('../utils/patch-or-post');
const patchOrPost = bindPatchOrPost(router);
const topbarController = require('../controller/topbar.controller');
const { requireAdmin } = require('../config/auth');

router.get('/', topbarController.getTopBar);
patchOrPost('/update', requireAdmin, topbarController.updateTopBar);

module.exports = router;
