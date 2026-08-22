const express = require('express');
const router = express.Router();
const uploader = require('../middleware/uploder');
const { cloudinaryController } = require('../controller/cloudinary.controller');
const multer = require('multer');
const { requireAdmin } = require('../config/auth');

const upload = multer();
const uploadMedia = multer({
  limits: { fileSize: 80 * 1024 * 1024 },
});

router.post('/add-img', requireAdmin, upload.single('image'), cloudinaryController.saveImageCloudinary);
router.post('/add-media', requireAdmin, uploadMedia.single('file'), cloudinaryController.saveMediaCloudinary);
router.post('/add-multiple-img', requireAdmin, upload.array('images',5), cloudinaryController.addMultipleImageCloudinary);
router.delete('/img-delete', requireAdmin, cloudinaryController.cloudinaryDeleteController);

module.exports = router;
