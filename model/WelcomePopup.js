const mongoose = require('mongoose');

const DEFAULTS = {
  isActive: true,
  image: '',
  heading: 'HEY, DIVA! ✨',
  subheading: 'Welcome to Cotniva 💗 A LITTLE WELCOME GIFT FOR YOU 🎁',
  body: 'Get 10% OFF on your first Cotniva order.',
  codePrefix: 'Use code',
  promoCode: 'WELCOME10',
  codeSuffix: 'at checkout.',
  buttonText: 'SHOP NOW',
  buttonLink: '/shop',
};

const welcomePopupSchema = mongoose.Schema(
  {
    isActive: { type: Boolean, default: DEFAULTS.isActive },
    image: { type: String, default: DEFAULTS.image },
    heading: { type: String, default: DEFAULTS.heading },
    subheading: { type: String, default: DEFAULTS.subheading },
    body: { type: String, default: DEFAULTS.body },
    codePrefix: { type: String, default: DEFAULTS.codePrefix },
    promoCode: { type: String, default: DEFAULTS.promoCode },
    codeSuffix: { type: String, default: DEFAULTS.codeSuffix },
    buttonText: { type: String, default: DEFAULTS.buttonText },
    buttonLink: { type: String, default: DEFAULTS.buttonLink },
  },
  { timestamps: true }
);

const WelcomePopup = mongoose.model('WelcomePopup', welcomePopupSchema);
module.exports = WelcomePopup;
module.exports.DEFAULTS = DEFAULTS;
