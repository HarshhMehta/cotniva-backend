const express = require("express");
const router = express.Router();
const sizeGuideController = require("../controller/sizeGuide.controller");
const { requireAdmin } = require("../config/auth");

router.post("/add", requireAdmin, sizeGuideController.addSizeGuide);
router.get("/all", requireAdmin, sizeGuideController.getAllSizeGuides);
router.get("/show", sizeGuideController.getShowSizeGuides);
router.get("/get/:id", sizeGuideController.getSizeGuide);
router.patch("/edit/:id", requireAdmin, sizeGuideController.updateSizeGuide);
router.delete("/delete/:id", requireAdmin, sizeGuideController.deleteSizeGuide);

module.exports = router;
