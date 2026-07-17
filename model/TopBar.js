const mongoose = require('mongoose');

const topBarSchema = mongoose.Schema({
  text: {
    type: String,
    required: true,
    default: "FREE SHIPPING ABOVE ₹1299 | COD AVAILABLE | 7 DAY EASY RETURNS"
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  bgColor: {
    type: String,
    default: "#4a0f0f",
  },
  textColor: {
    type: String,
    default: "#ffffff",
  },
}, { timestamps: true });

const TopBar = mongoose.model('TopBar', topBarSchema);
module.exports = TopBar;