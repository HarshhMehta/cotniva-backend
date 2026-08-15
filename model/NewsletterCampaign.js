const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const CAMPAIGN_STATUSES = ["draft", "sending", "completed", "failed"];

/**
 * Audit trail for admin newsletter / marketing sends.
 */
const newsletterCampaignSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: [200, "Subject is too long"],
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: [50000, "Content is too long"],
    },
    recipientCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    sentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    failedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: "draft",
      lowercase: true,
      index: true,
    },
    isTest: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      default: null,
    },
    failures: {
      type: [
        {
          email: String,
          error: String,
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

newsletterCampaignSchema.statics.STATUSES = CAMPAIGN_STATUSES;

const NewsletterCampaign =
  mongoose.models.NewsletterCampaign ||
  mongoose.model("NewsletterCampaign", newsletterCampaignSchema);

module.exports = NewsletterCampaign;
