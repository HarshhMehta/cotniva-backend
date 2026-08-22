const express = require('express');
const { fileUpload } = require('../controller/upload.controller');
const uploader = require('../middleware/uploder');
const { requireAdmin } = require('../config/auth');

const router = express.Router();

router.post('/single', requireAdmin, uploader.single('file'), fileUpload)

module.exports = router;
