const express = require("express");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");
const {
  getProfile,
  signIn,
  signUp,
  sendOtp,
  resendOtp,
  forgotPassword,
  resetPassword,
  activation,
} = require("../controllers/AuthController");

router.get("/profile", auth, getProfile);
router.post("/signin", signIn);
router.post("/signUp", signUp);
router.post("/forgot-password", forgotPassword);
router.post("/sendForgotOtp", sendOtp);
router.post("/resend-otp", resendOtp);
router.post("/reset-password", resetPassword);
router.post("/activation", activation);

module.exports = router;
