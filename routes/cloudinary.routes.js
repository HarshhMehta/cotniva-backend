const express = require('express');
const router = express.Router();
// internal
const uploader = require('../middleware/uploder');
const { cloudinaryController } = require('../controller/cloudinary.controller');
const multer = require('multer');

const upload = multer();
const uploadMedia = multer({
  limits: { fileSize: 80 * 1024 * 1024 }, // 80MB for gallery videos
});
//add image
router.post('/add-img',upload.single('image'), cloudinaryController.saveImageCloudinary);

// add image or video (gallery)
router.post('/add-media', uploadMedia.single('file'), cloudinaryController.saveMediaCloudinary);

//add image
router.post('/add-multiple-img',upload.array('images',5), cloudinaryController.addMultipleImageCloudinary);

//delete image
router.delete('/img-delete', cloudinaryController.cloudinaryDeleteController);

module.exports = router;