const mongoose = require("mongoose");
const validator = require("validator");

const gallerySchema = mongoose.Schema(
  {
    img: {
      type: String,
      required: [true, "Please provide gallery image"],
      validate: [validator.isURL, "Please provide valid url"],
    },
    link: {
      type: String,
      default: "/shop",
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

const Gallery = mongoose.model("Gallery", gallerySchema);
module.exports = Gallery;
