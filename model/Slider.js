const mongoose = require("mongoose");
const validator = require("validator");

const sliderSchema = mongoose.Schema({
  img: {
    type: String,
    required: [true, "Please provide slider image"],
    validate: [validator.isURL, "Please provide valid url"],
  },
  title: {
    type: String,
    trim: true,
    required: [true, "Please provide a title"],
    maxLength: 200,
  },
  link: {
    type: String,
    default: "/shop",
  },
  pre_title_text: { type: String, default: "Starting at" },
  pre_title_price: { type: Number, default: 0 },
  subtitle_text_1: { type: String, default: "" },
  subtitle_percent: { type: Number, default: 0 },
  subtitle_text_2: { type: String, default: "" },
  bg_type: {
    type: String,
    enum: ["green_bg", "light", "default"],
    default: "green_bg",
  },
  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active",
  },
  order: { type: Number, default: 0 },
}, { timestamps: true });

const Slider = mongoose.model("Slider", sliderSchema);
module.exports = Slider;
