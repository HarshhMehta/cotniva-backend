const mongoose = require('mongoose');

const DEFAULT_MESSAGES = [
  'FREE SHIPPING ABOVE ₹1299',
  'COD AVAILABLE',
  '7 DAY EASY RETURNS',
];

const topBarSchema = mongoose.Schema(
  {
    /** @deprecated Prefer `messages` — kept as joined fallback for older clients */
    text: {
      type: String,
      required: false,
      default: DEFAULT_MESSAGES.join('  ·  '),
    },
    /** Up to 3 promo lines shown in the storefront marquee */
    messages: {
      type: [String],
      default: () => [...DEFAULT_MESSAGES],
      validate: {
        validator(arr) {
          return !arr || arr.length <= 3;
        },
        message: 'You can add up to 3 top bar messages',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    bgColor: {
      type: String,
      default: '#4a0f0f',
    },
    textColor: {
      type: String,
      default: '#ffffff',
    },
  },
  { timestamps: true }
);

const TopBar = mongoose.model('TopBar', topBarSchema);
module.exports = TopBar;
module.exports.DEFAULT_MESSAGES = DEFAULT_MESSAGES;
