const express = require("express");
const {
  registerAdmin,
  loginAdmin,
  logoutAdmin,
  meAdmin,
  refreshAdminSession,
  bootstrapStatus,
  updateStaff,
  changePassword,
  addStaff,
  getAllStaff,
  deleteStaff,
  getStaffById,
  forgetPassword,
  confirmAdminForgetPass,
} = require("../controller/admin.controller");
const { requireAdmin } = require("../config/auth");

const router = express.Router();
const { bindPatchOrPost } = require("../utils/patch-or-post");
const patchOrPost = bindPatchOrPost(router);

router.get("/bootstrap-status", bootstrapStatus);

router.post("/login", loginAdmin);
router.post("/logout", logoutAdmin);
router.get("/me", requireAdmin, meAdmin);
router.post("/refresh", refreshAdminSession);
patchOrPost("/forget-password", forgetPassword);
patchOrPost("/confirm-forget-password", confirmAdminForgetPass);

router.post("/register", registerAdmin);

router.post("/add", requireAdmin, addStaff);
router.get("/all", requireAdmin, getAllStaff);
router.get("/get/:id", requireAdmin, getStaffById);
patchOrPost("/update-stuff/:id", requireAdmin, updateStaff);
router.delete("/:id", requireAdmin, deleteStaff);
patchOrPost("/change-password", requireAdmin, changePassword);

module.exports = router;
