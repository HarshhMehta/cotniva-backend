const express = require('express');
const router = express.Router();
const sliderController = require('../controller/slider.controller');
const { requireAdmin } = require('../config/auth');

router.post('/add', requireAdmin, sliderController.addSlider);
router.get('/all', requireAdmin, sliderController.getAllSliders);
router.get('/active', sliderController.getActiveSliders);
router.get('/get/:id', requireAdmin, sliderController.getSingleSlider);
router.patch('/edit/:id', requireAdmin, sliderController.updateSlider);
router.delete('/delete/:id', requireAdmin, sliderController.deleteSlider);

module.exports = router;
