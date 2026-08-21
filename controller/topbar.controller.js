const TopBar = require('../model/TopBar');
const { DEFAULT_MESSAGES } = TopBar;

const MAX_MESSAGES = 3;

const cleanMessages = (raw) => {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((m) => String(m || '').trim())
    .filter(Boolean)
    .slice(0, MAX_MESSAGES);
};

const messagesFromText = (text = '') => {
  const parts = String(text)
    .split(/\s*[|·•]\s*|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length) return parts.slice(0, MAX_MESSAGES);
  const single = String(text || '').trim();
  return single ? [single] : [];
};

/** Ensure API always returns a usable messages[] + joined text */
const toPublic = (doc) => {
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  let messages = cleanMessages(plain.messages);
  if (!messages || !messages.length) {
    messages = messagesFromText(plain.text);
  }
  if (!messages.length) messages = [...DEFAULT_MESSAGES];
  plain.messages = messages;
  plain.text = messages.join('  ·  ');
  return plain;
};

const ensureTopBar = async () => {
  let topbar = await TopBar.findOne();
  if (!topbar) {
    topbar = await TopBar.create({
      messages: [...DEFAULT_MESSAGES],
      text: DEFAULT_MESSAGES.join('  ·  '),
    });
    return topbar;
  }
  // Migrate legacy docs that only have `text`
  if (!Array.isArray(topbar.messages) || topbar.messages.length === 0) {
    const migrated = messagesFromText(topbar.text);
    if (migrated.length) {
      topbar.messages = migrated;
      topbar.text = migrated.join('  ·  ');
      await topbar.save();
    }
  }
  return topbar;
};

exports.getTopBar = async (req, res, next) => {
  try {
    const topbar = await ensureTopBar();
    res.status(200).json({ success: true, data: toPublic(topbar) });
  } catch (error) {
    next(error);
  }
};

exports.updateTopBar = async (req, res, next) => {
  try {
    let topbar = await TopBar.findOne();
    const incomingMessages = cleanMessages(req.body?.messages);
    const nextMessages =
      incomingMessages && incomingMessages.length
        ? incomingMessages
        : messagesFromText(req.body?.text);

    if (!topbar) {
      const messages =
        nextMessages.length > 0 ? nextMessages : [...DEFAULT_MESSAGES];
      topbar = await TopBar.create({
        messages,
        text: messages.join('  ·  '),
        isActive: req.body?.isActive !== undefined ? req.body.isActive : true,
        bgColor: req.body?.bgColor || '#4a0f0f',
        textColor: req.body?.textColor || '#ffffff',
      });
    } else {
      if (nextMessages.length > 0) {
        topbar.messages = nextMessages;
        topbar.text = nextMessages.join('  ·  ');
      } else if (req.body?.text !== undefined) {
        const fromText = messagesFromText(req.body.text);
        topbar.messages = fromText.length ? fromText : [...DEFAULT_MESSAGES];
        topbar.text = topbar.messages.join('  ·  ');
      }
      if (req.body?.isActive !== undefined) topbar.isActive = req.body.isActive;
      if (req.body?.bgColor) topbar.bgColor = req.body.bgColor;
      if (req.body?.textColor) topbar.textColor = req.body.textColor;
      await topbar.save();
    }
    res.status(200).json({ success: true, data: toPublic(topbar) });
  } catch (error) {
    next(error);
  }
};

exports.toPublicTopBar = toPublic;
exports.ensureTopBar = ensureTopBar;
