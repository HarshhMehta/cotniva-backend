const mongoose = require("mongoose");
const validator = require("validator");

const gallerySchema = mongoose.Schema(
  {
    // Media URL — image or video (Cloudinary / CDN)
    img: {
      type: String,
      required: [true, "Please provide gallery media URL"],
      validate: [validator.isURL, "Please provide valid url"],
    },
    // Optional poster/thumbnail for videos
    poster: {
      type: String,
      required: false,
      default: "",
    },
    mediaType: {
      type: String,
      enum: ["image", "video"],
      default: "image",
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
