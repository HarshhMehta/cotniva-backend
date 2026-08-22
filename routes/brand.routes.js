const express = require('express');
const router = express.Router();
const brandController = require('../controller/brand.controller');
const { requireAdmin } = require('../config/auth');

router.post('/add', requireAdmin, brandController.addBrand);
router.post('/add-all', requireAdmin, brandController.addAllBrand);
router.get('/active', brandController.getActiveBrands);
router.get('/all', brandController.getAllBrands);
router.delete('/delete/:id', requireAdmin, brandController.deleteBrand);
router.get('/get/:id', brandController.getSingleBrand);
router.patch('/edit/:id', requireAdmin, brandController.updateBrand);

module.exports = router;
