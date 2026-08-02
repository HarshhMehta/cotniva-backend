const mongoose = require("mongoose");

const SizeGuideSchema = mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Size guide title is required"],
      trim: true,
      unique: true,
    },
    unitLabel: {
      type: String,
      default: "BODY MEASUREMENTS IN INCHES",
      trim: true,
    },
    // e.g. ["XS","S","M","L","XL","XXL"]
    sizes: {
      type: [String],
      default: ["XS", "S", "M", "L", "XL", "XXL"],
    },
    // e.g. [{ label: "CHEST", values: ["28-30","30-32",...] }]
    rows: [
      {
        label: { type: String, required: true, trim: true },
        values: { type: [String], default: [] },
      },
    ],
    tip: {
      type: String,
      default: "TIP: If you don't find your exact size, go for the next size.",
    },
    howToMeasure: [
      {
        label: { type: String, trim: true },
        text: { type: String, trim: true },
      },
    ],
    tagline: {
      type: String,
      default: "SIMPLE, RIGHT? NOW YOU'RE READY TO OWN YOUR PERFECT FIT!",
    },
    // Schematic / farma diagram image URL
    diagramImage: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["Show", "Hide"],
      default: "Show",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SizeGuide", SizeGuideSchema);
