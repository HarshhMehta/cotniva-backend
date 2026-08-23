const express = require('express');
const router = express.Router();
const { bindPatchOrPost } = require('../utils/patch-or-post');
const patchOrPost = bindPatchOrPost(router);
const categoryController = require('../controller/category.controller');
const { requireAdmin } = require('../config/auth');

router.get('/get/:id', categoryController.getSingleCategory);
router.post('/add', requireAdmin, categoryController.addCategory);
router.post('/add-all', requireAdmin, categoryController.addAllCategory);
router.get('/all', categoryController.getAllCategory);
router.get('/show/:type', categoryController.getProductTypeCategory);
router.get('/show', categoryController.getShowCategory);
router.delete('/delete/:id', requireAdmin, categoryController.deleteCategory);
patchOrPost('/edit/:id', requireAdmin, categoryController.updateCategory);

module.exports = router;
