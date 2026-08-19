const express = require('express');
const router = express.Router();
const userController= require('../controller/user.controller');
const addressController = require('../controller/address.controller');
const verifyToken = require('../middleware/verifyToken');
const requireStoreOrigin = require('../middleware/require-store-origin');


// add a user
router.post("/signup", userController.signup);
// login
router.post("/login", userController.login);
// forget-password
router.patch('/forget-password', userController.forgetPassword);
// confirm-forget-password
router.patch('/confirm-forget-password', userController.confirmForgetPassword);
// change password
router.patch('/change-password', userController.changePassword);
// confirmEmail
router.get('/confirmEmail/:token', userController.confirmEmail);
// Saved addresses (logged-in user — cookie/Bearer)
router.get('/addresses', verifyToken, addressController.list);
router.post('/addresses/import', verifyToken, requireStoreOrigin, addressController.importMany);
router.post('/addresses', verifyToken, requireStoreOrigin, addressController.create);
router.put('/addresses/:addrId', verifyToken, requireStoreOrigin, addressController.update);
router.patch('/addresses/:addrId/default', verifyToken, requireStoreOrigin, addressController.setDefault);
router.delete('/addresses/:addrId', verifyToken, requireStoreOrigin, addressController.remove);
// updateUser
router.put('/update-user/:id', verifyToken, userController.updateUser);
// register or login with google
router.post("/register/:token", userController.signUpWithProvider);

module.exports = router;