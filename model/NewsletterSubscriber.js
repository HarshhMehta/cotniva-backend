const mongoose = require("mongoose");
const crypto = require("crypto");

/**
 * Storefront newsletter subscribers.
 * Marketing emails go to subscribed=true recipients (single opt-in).
 */
const newsletterSubscriberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      maxlength: [254, "Email is too long"],
    },
    /** True once the customer is on the list (immediate subscribe) */
    subscribed: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** Legacy field — kept in sync with subscribed for older records */
    verified: {
      type: Boolean,
      default: false,
      index: true,
    },
    subscribedAt: {
      type: Date,
      default: null,
    },
    unsubscribedAt: {
      type: Date,
      default: null,
    },
    verifyToken: {
      type: String,
      default: null,
      index: true,
    },
    verifyTokenExpires: {
      type: Date,
      default: null,
    },
    unsubscribeToken: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true,
    },
  },
  { timestamps: true }
);

newsletterSubscriberSchema.methods.issueVerifyToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.verifyToken = token;
  const expires = new Date();
  expires.setDate(expires.getDate() + 2);
  this.verifyTokenExpires = expires;
  return token;
};

newsletterSubscriberSchema.methods.ensureUnsubscribeToken = function () {
  if (!this.unsubscribeToken) {
    this.unsubscribeToken = crypto.randomBytes(32).toString("hex");
  }
  return this.unsubscribeToken;
};

const NewsletterSubscriber =
  mongoose.models.NewsletterSubscriber ||
  mongoose.model("NewsletterSubscriber", newsletterSubscriberSchema);

module.exports = NewsletterSubscriber;
