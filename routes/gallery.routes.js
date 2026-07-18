const express = require("express");
const router = express.Router();
const galleryController = require("../controller/gallery.controller");

router.post("/add", galleryController.addGallery);
router.get("/all", galleryController.getAllGallery);
router.get("/active", galleryController.getActiveGallery);
router.get("/get/:id", galleryController.getSingleGallery);
router.patch("/edit/:id", galleryController.updateGallery);
router.delete("/delete/:id", galleryController.deleteGallery);

module.exports = router;
