const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const pino = require("pino");
const { useMongoAuthState } = require("./whatsapp-mongo-auth");

const AUTH_DIR = path.join(__dirname, "..", "whatsapp-auth");

let sock = null;
let latestQr = null;
let connectionStatus = "disconnected"; // disconnected | qr | connecting | connected
let connectedNumber = null;
let startPromise = null;
let clearAuthFn = null;
let retries = 0;

const ensureAuthDir = () => {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
};

const getBaileys = () => require("@whiskeysockets/baileys");

/**
 * Same pattern as KwikTeach WA server — simple Baileys socket.
 * Auth state is Mongo-backed (Render disk is ephemeral) but API matches
 * useMultiFileAuthState so send behaves the same for new numbers.
 */
const startWhatsApp = async () => {
  if (sock && (connectionStatus === "connected" || connectionStatus === "qr")) {
    return sock;
  }
  if (startPromise) return startPromise;

  startPromise = (async () => {
    ensureAuthDir();
    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = getBaileys();

    const { state, saveCreds, clearAuth } = await useMongoAuthState(AUTH_DIR);
    clearAuthFn = clearAuth;

    const { version } = await fetchLatestBaileysVersion();
    console.log(`WhatsApp Baileys v${version.join(".")}`);

    connectionStatus = "connecting";
    latestQr = null;

    // Match working KwikTeach socket options (auth: state as-is)
    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Cotniva", "Chrome", "120.0"],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = "qr";
        try {
          latestQr = await qrcode.toDataURL(qr, { width: 300, margin: 1 });
        } catch (err) {
          console.error("QR generate error:", err.message);
          latestQr = null;
        }
      }

      if (connection === "open") {
        connectionStatus = "connected";
        latestQr = null;
        connectedNumber =
          sock?.user?.id?.split(":")?.[0] || sock?.user?.id || null;
        retries = 0;
        console.log("WhatsApp connected:", connectedNumber);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        connectionStatus = "disconnected";
        connectedNumber = null;
        latestQr = null;
        sock = null;
        startPromise = null;

        if (loggedOut) {
          console.log("WhatsApp logged out — clearing persisted auth");
          if (typeof clearAuthFn === "function") {
            clearAuthFn().catch((e) =>
              console.error("Clear WhatsApp Mongo auth:", e.message)
            );
          }
          try {
            if (fs.existsSync(AUTH_DIR)) {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
          } catch (err) {
            console.error("Clear auth dir error:", err.message);
          }
          retries = 0;
          setTimeout(() => {
            startWhatsApp().catch((e) =>
              console.error("WhatsApp restart failed:", e.message)
            );
          }, 3000);
        } else if (retries < 5) {
          retries += 1;
          const delay = Math.min(3000 * retries, 30000);
          console.log(
            `WhatsApp disconnected, reconnecting in ${delay}ms (attempt ${retries})...`
          );
          setTimeout(() => {
            startWhatsApp().catch((e) =>
              console.error("WhatsApp reconnect failed:", e.message)
            );
          }, delay);
        }
      }
    });

    return sock;
  })();

  try {
    return await startPromise;
  } catch (err) {
    startPromise = null;
    throw err;
  }
};

const getStatus = () => ({
  status: connectionStatus,
  qr: latestQr,
  number: connectedNumber,
});

const normalizePhone = (phone) => {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.startsWith("0") && digits.length === 11) {
    digits = `91${digits.slice(1)}`;
  }
  return digits;
};

/** Same JID format as KwikTeach formatPhone() */
const formatPhoneJid = (phone) => {
  const clean = normalizePhone(phone);
  if (clean.length === 10) return `91${clean}@s.whatsapp.net`;
  if (clean.startsWith("91") && clean.length === 12) {
    return `${clean}@s.whatsapp.net`;
  }
  return `${clean}@s.whatsapp.net`;
};

/**
 * KwikTeach-style send — direct sendMessage, no whitelist / onWhatsApp gate.
 * Works for new (unknown) numbers the same way as your other WA OTP server.
 */
const sendWhatsAppText = async (phone, message) => {
  if (connectionStatus !== "connected" || !sock) {
    throw new Error("WhatsApp is not connected. Scan QR in admin panel.");
  }

  const jid = formatPhoneJid(phone);
  await sock.sendMessage(jid, { text: message });
  console.log(`WhatsApp message sent to ${jid}`);
  return true;
};

const logoutWhatsApp = async () => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (_) {}
      try {
        sock.ev.removeAllListeners();
        sock.end?.();
      } catch (_) {}
    }
  } catch (err) {
    console.error("WhatsApp logout error:", err.message);
  }

  sock = null;
  latestQr = null;
  connectionStatus = "disconnected";
  connectedNumber = null;
  startPromise = null;
  retries = 0;

  try {
    if (typeof clearAuthFn === "function") {
      await clearAuthFn();
    }
  } catch (err) {
    console.error("Clear WhatsApp Mongo auth error:", err.message);
  }

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Clear auth dir error:", err.message);
  }

  setTimeout(() => {
    startWhatsApp().catch((e) =>
      console.error("WhatsApp restart after logout failed:", e.message)
    );
  }, 1500);
};

module.exports = {
  startWhatsApp,
  getStatus,
  sendWhatsAppText,
  logoutWhatsApp,
  normalizePhone,
  AUTH_DIR,
};
