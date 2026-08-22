const WelcomePopup = require('../model/WelcomePopup');
const { DEFAULTS } = WelcomePopup;

const ensurePopup = async () => {
  let doc = await WelcomePopup.findOne();
  if (!doc) {
    doc = await WelcomePopup.create({ ...DEFAULTS });
  }
  return doc;
};

exports.getWelcomePopup = async (req, res, next) => {
  try {
    const doc = await ensurePopup();
    const { setPublicCache, PUBLIC_SETTINGS_CACHE } = require('../utils/public-cache');
    setPublicCache(res, PUBLIC_SETTINGS_CACHE);
    res.status(200).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};

exports.updateWelcomePopup = async (req, res, next) => {
  try {
    let doc = await WelcomePopup.findOne();
    const body = req.body || {};

    const fields = [
      'isActive',
      'image',
      'heading',
      'subheading',
      'body',
      'codePrefix',
      'promoCode',
      'codeSuffix',
      'buttonText',
      'buttonLink',
    ];

    if (!doc) {
      const payload = { ...DEFAULTS };
      for (const key of fields) {
        if (body[key] !== undefined) payload[key] = body[key];
      }
      doc = await WelcomePopup.create(payload);
    } else {
      for (const key of fields) {
        if (body[key] !== undefined) doc[key] = body[key];
      }
      await doc.save();
    }

    res.status(200).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};
