const express = require("express");
const router = express.Router();
const { bindPatchOrPost } = require("../utils/patch-or-post");
const patchOrPost = bindPatchOrPost(router);
const galleryController = require("../controller/gallery.controller");
const { requireAdmin } = require("../config/auth");

router.post("/add", requireAdmin, galleryController.addGallery);
router.get("/all", requireAdmin, galleryController.getAllGallery);
router.get("/active", galleryController.getActiveGallery);
router.get("/get/:id", requireAdmin, galleryController.getSingleGallery);
patchOrPost("/edit/:id", requireAdmin, galleryController.updateGallery);
router.delete("/delete/:id", requireAdmin, galleryController.deleteGallery);

module.exports = router;
