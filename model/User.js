const mongoose = require("mongoose");
const validator = require("validator");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const userSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a name"],
      trim: true,
      minLength: [3, "Name must be at least 3 characters."],
      maxLength: [100, "Name is too large"],
    },
    email: {
      type: String,
      validate: {
        validator: function (v) {
          if (!v) return true;
          return validator.isEmail(v);
        },
        message: "Provide a valid Email",
      },
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      required: false,
    },
    password: {
      type: String,
      required: [false, "Password is required"],
      minLength: [6, "Must be at least 6 character"],
    },

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    contactNumber: {
      type: String,
      required: false,
    },

    shippingAddress: String,

    imageURL: {
      type: String,
      required: false,
    },
    phone: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      index: true,
    },
    address: {
      type: String,
      required: false,
    },
    bio: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      default: "inactive",
      enum: ["active", "inactive", "blocked"],
    },
    reviews: [{ type: mongoose.Schema.Types.ObjectId, ref: "Reviews" }],
    confirmationToken: String,
    confirmationTokenExpires: Date,

    passwordChangedAt: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,

    // Customer tracking (admin / marketing foundation)
    registeredAt: {
      type: Date,
      default: Date.now,
    },
    lastLogin: {
      type: Date,
      required: false,
    },
    lastOrderAt: {
      type: Date,
      required: false,
    },
    cartUpdatedAt: {
      type: Date,
      required: false,
    },
    currentCart: {
      type: Object,
      required: false,
      default: null,
    },
    wishlistCount: {
      type: Number,
      default: 0,
    },
    savedAddresses: {
      type: [
        {
          firstName: String,
          lastName: String,
          address: String,
          city: String,
          zipCode: String,
          country: String,
          contactNo: String,
          email: String,
          isDefault: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

userSchema.pre("save", function (next) {
  if (!this.isModified("password") || !this.password) {
    return next();
  }
  const password = this.password;
  const hashedPassword = bcrypt.hashSync(password);
  this.password = hashedPassword;

  next();
});
// comparePassword
userSchema.methods.comparePassword = function (password, hash) {
  const isPasswordValid = bcrypt.compareSync(password, hash);
  return isPasswordValid;
};
// generateConfirmationToken
userSchema.methods.generateConfirmationToken = function () {
  const token = crypto.randomBytes(32).toString("hex");

  this.confirmationToken = token;

  const date = new Date();

  date.setDate(date.getDate() + 1);
  this.confirmationTokenExpires = date;

  return token;
};

const User = mongoose.model("User", userSchema);

module.exports = User;
