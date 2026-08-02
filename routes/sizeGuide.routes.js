const express = require("express");
const router = express.Router();
const sizeGuideController = require("../controller/sizeGuide.controller");

router.post("/add", sizeGuideController.addSizeGuide);
router.get("/all", sizeGuideController.getAllSizeGuides);
router.get("/show", sizeGuideController.getShowSizeGuides);
router.get("/get/:id", sizeGuideController.getSizeGuide);
router.patch("/edit/:id", sizeGuideController.updateSizeGuide);
router.delete("/delete/:id", sizeGuideController.deleteSizeGuide);

module.exports = router;
