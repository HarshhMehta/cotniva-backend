const mongoose = require('mongoose');
const { ObjectId } = mongoose.Schema.Types;
// schema design
const validator = require("validator");

const productsSchema = mongoose.Schema({
  sku: {
    type: String,
    required: false,
  },
  title: {
    type: String,
    required: [true, "Please provide a name for this product."],
    trim: true,
    minLength: [3, "Name must be at least 3 characters."],
    maxLength: [200, "Name is too large"],
  },
  slug: {
    type: String,
    trim: true,
    required: false,
  },
  unit: {
    type: String,
    required: true,
  },
  imageURLs: [{
    img:{
      type: String,
      required: false,
      validate: [validator.isURL, "Please provide valid url(s)"]
    },
    isDefault: {
      type: Boolean,
      default: false
    },
    // kept optional for old products — no longer used in UI
    color:{
      name:{ type: String, required: false, trim: true },
      clrCode:{ type: String, required: false, trim: true }
    },
    sizes:[String],
  }],
  sizes: {
    type: [String],
    default: [],
  },
  /**
   * Per-size stock. Example:
   * sizes: ["S","M"]
   * sizeInventory: [{ size: "S", quantity: 1 }, { size: "M", quantity: 1 }]
   * quantity (below) = sum of sizeInventory quantities when this array is set.
   * Legacy products may omit this; do not auto-split their quantity across sizes.
   */
  sizeInventory: {
    type: [
      {
        size: {
          type: String,
          required: true,
          trim: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: [0, "Size quantity can't be negative"],
          default: 0,
        },
      },
    ],
    default: [],
    validate: {
      validator(list) {
        if (!Array.isArray(list) || list.length === 0) return true;
        const keys = list
          .map((row) => String(row?.size || "").trim().toUpperCase())
          .filter(Boolean);
        return keys.length === new Set(keys).size;
      },
      message: "Duplicate sizes are not allowed in sizeInventory",
    },
  },
  sizeGuide: {
    type: ObjectId,
    ref: "SizeGuide",
    required: false,
    default: null,
  },
  parent:{
    type:String,
    required:true,
    trim:true,
   },
  children:{
    type:String,
    required: false,
    default: "",
    trim:true,
  },
  price: {
    type: Number,
    required: true,
    min: [0, "Product price can't be negative"]
  },
  discount: {
    type: Number,
    min: [0, "Product price can't be negative"]
  },
  quantity: {
    type: Number,
    required: true,
    min: [0, "Product quantity can't be negative"]
  },
  brand: {
    name: {
      type: String,
      required: false,
      default: "",
    },
    id: {
      type: ObjectId,
      ref: "Brand",
      required: false,
      default: null,
    }
  },
  category: {
    name: {
      type: String,
      required: true,
    },
    id: {
      type: ObjectId,
      ref: "Category",
      required: true,
    }
  },
  status: {
    type: String,
    required: true,
    enum: {
      values: ["in-stock", "out-of-stock", "discontinued"],
      message: "status can't be {VALUE} "
    },
    default: "in-stock",
  },
  reviews: [{type:ObjectId, ref: 'Reviews' }],
  productType:{
    type:String,
    required: false,
    default: "general",
    lowercase: true,
  },
  description: {
    type: String,
    required: true
  },
  /** Accordion: Product Highlights (multiline text) */
  productHighlights: {
    type: String,
    required: false,
    default: "",
  },
  /** Accordion: Fabric & Care (multiline text) */
  fabricCare: {
    type: String,
    required: false,
    default: "",
  },
  videoId: {
    type: String,
    required: false
  },
  additionalInformation: [{}],
  tags: [String],
  offerDate:{
    startDate:{
      type:Date
    },
    endDate:{
      type:Date
    },
  },
  featured: {
    type: Boolean,
    default: false,
  },
  newArrival: {          
    type: Boolean,
    default: false,
  },
  bestSeller: {
    type: Boolean,
    default: false,
  },
  sellCount: {
    type: Number,
    default: 0,
    min: 0
  }
}, {
  timestamps: true,
})

productsSchema.pre("validate", function (next) {
  if (!Array.isArray(this.sizeInventory)) {
    this.sizeInventory = [];
  }

  this.sizeInventory = this.sizeInventory
    .filter((row) => row && String(row.size || "").trim())
    .map((row) => ({
      size: String(row.size).trim(),
      quantity: Math.max(0, Number(row.quantity) || 0),
    }));

  const seen = new Set();
  for (const row of this.sizeInventory) {
    const key = row.size.toUpperCase();
    if (seen.has(key)) {
      return next(new Error("Duplicate sizes are not allowed in sizeInventory"));
    }
    seen.add(key);
  }

  // Only sync total when size-wise stock is present. Leave legacy quantity untouched.
  if (this.sizeInventory.length > 0) {
    this.quantity = this.sizeInventory.reduce(
      (sum, row) => sum + (Number(row.quantity) || 0),
      0
    );
  }

  if (this.status !== "discontinued") {
    this.status = Number(this.quantity) > 0 ? "in-stock" : "out-of-stock";
  }

  next();
});

const Products = mongoose.model('Products', productsSchema)

module.exports = Products;