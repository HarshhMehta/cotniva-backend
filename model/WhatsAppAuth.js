const mongoose = require("mongoose");

/**
 * Baileys multi-file auth mirrored in Mongo so sessions survive
 * Render/Heroku restarts (ephemeral filesystem).
 */
const whatsappAuthSchema = new mongoose.Schema(
  {
    _id: { type: String },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  {
    collection: "whatsapp_auth",
    versionKey: false,
  }
);

module.exports =
  mongoose.models.WhatsAppAuth ||
  mongoose.model("WhatsAppAuth", whatsappAuthSchema);
