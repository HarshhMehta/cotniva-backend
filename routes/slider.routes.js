const express = require('express');
const router = express.Router();
const sliderController = require('../controller/slider.controller');

router.post('/add', sliderController.addSlider);
router.get('/all', sliderController.getAllSliders);
router.get('/active', sliderController.getActiveSliders);
router.get('/get/:id', sliderController.getSingleSlider);
router.patch('/edit/:id', sliderController.updateSlider);
router.delete('/delete/:id', sliderController.deleteSlider);

module.exports = router;
