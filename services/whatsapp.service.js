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

const ensureAuthDir = () => {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
};

const getBaileys = () => require("@whiskeysockets/baileys");

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

    // Persist session in MongoDB so Render restarts do not force re-scan
    const { state, saveCreds, clearAuth } = await useMongoAuthState(AUTH_DIR);
    clearAuthFn = clearAuth;

    const { version } = await fetchLatestBaileysVersion();

    connectionStatus = "connecting";
    latestQr = null;

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Cotniva", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = "qr";
        try {
          latestQr = await qrcode.toDataURL(qr);
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
        console.log("WhatsApp connected:", connectedNumber);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = "disconnected";
        connectedNumber = null;
        latestQr = null;
        sock = null;
        startPromise = null;

        if (shouldReconnect) {
          console.log("WhatsApp disconnected, reconnecting...");
          setTimeout(() => {
            startWhatsApp().catch((e) =>
              console.error("WhatsApp reconnect failed:", e.message)
            );
          }, 3000);
        } else {
          console.log("WhatsApp logged out — clearing persisted auth");
          // True logout from phone / admin Disconnect: wipe Mongo so QR is required
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

const sendWhatsAppText = async (phone, message) => {
  if (connectionStatus !== "connected" || !sock) {
    throw new Error("WhatsApp is not connected. Scan QR in admin panel.");
  }

  const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
  return true;
};

const logoutWhatsApp = async () => {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (err) {
    console.error("WhatsApp logout error:", err.message);
  }

  sock = null;
  latestQr = null;
  connectionStatus = "disconnected";
  connectedNumber = null;
  startPromise = null;

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
};

module.exports = {
  startWhatsApp,
  getStatus,
  sendWhatsAppText,
  logoutWhatsApp,
  normalizePhone,
  AUTH_DIR,
};
