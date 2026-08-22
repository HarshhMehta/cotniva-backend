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

router.get("/bootstrap-status", bootstrapStatus);

router.post("/login", loginAdmin);
router.post("/logout", logoutAdmin);
router.get("/me", requireAdmin, meAdmin);
router.post("/refresh", refreshAdminSession);
router.patch("/forget-password", forgetPassword);
router.patch("/confirm-forget-password", confirmAdminForgetPass);

router.post("/register", registerAdmin);

router.post("/add", requireAdmin, addStaff);
router.get("/all", requireAdmin, getAllStaff);
router.get("/get/:id", requireAdmin, getStaffById);
router.patch("/update-stuff/:id", requireAdmin, updateStaff);
router.delete("/:id", requireAdmin, deleteStaff);
router.patch("/change-password", requireAdmin, changePassword);

module.exports = router;
