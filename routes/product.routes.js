const express = require('express');
const router = express.Router();
const { bindPatchOrPost } = require('../utils/patch-or-post');
const patchOrPost = bindPatchOrPost(router);
const productController = require('../controller/product.controller');
const { requireAdmin } = require('../config/auth');

router.post('/add', requireAdmin, productController.addProduct);
router.post('/add-all', requireAdmin, productController.addAllProducts);
router.post('/check-stock', productController.checkProductStock);
router.get('/facets', productController.getProductFacets);
router.get('/all', productController.getAllProducts);
router.get('/offer', productController.getOfferTimerProducts);
router.get('/new-arrival', productController.getNewArrivalProducts);
router.get('/best-seller', productController.getBestSellerProducts);
router.get('/top-rated', productController.getTopRatedProducts);
router.get('/review-product', productController.reviewProducts);
router.get('/popular/:type', productController.getPopularProductByType);
router.get('/related-product/:id', productController.getRelatedProducts);
router.get("/single-product/:id", productController.getSingleProduct);
router.get("/stock-out", requireAdmin, productController.stockOutProducts);
patchOrPost("/edit-product/:id", requireAdmin, productController.updateProduct);
router.get('/:type', productController.getProductsByType);
router.delete('/:id', requireAdmin, productController.deleteProduct);

module.exports = router;
