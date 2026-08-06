const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const pino = require("pino");
const { useHybridAuthState } = require("./whatsapp-mongo-auth");

const AUTH_DIR = path.join(__dirname, "..", "whatsapp-auth");

let sock = null;
let latestQr = null;
let connectionStatus = "disconnected"; // disconnected | qr | connecting | connected
let connectedNumber = null;
let startPromise = null;
let clearAuthFn = null;
let syncDiskToMongoFn = null;
let retries = 0;
let syncTimer = null;

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

    // Same as KwikTeach: useMultiFileAuthState under the hood + Mongo mirror
    const { state, saveCreds, clearAuth, syncDiskToMongo } =
      await useHybridAuthState(AUTH_DIR);
    clearAuthFn = clearAuth;
    syncDiskToMongoFn = syncDiskToMongo;

    const { version } = await fetchLatestBaileysVersion();
    console.log(`WhatsApp Baileys v${version.join(".")}`);

    connectionStatus = "connecting";
    latestQr = null;

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

    if (syncTimer) clearInterval(syncTimer);
    // Persist session keys often (Render can kill the process anytime)
    syncTimer = setInterval(() => {
      if (typeof syncDiskToMongoFn === "function") {
        syncDiskToMongoFn().catch(() => {});
      }
    }, 20000);

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
        if (typeof syncDiskToMongoFn === "function") {
          syncDiskToMongoFn().catch(() => {});
        }
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
              console.error("Clear WhatsApp auth:", e.message)
            );
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

/** Same as KwikTeach formatPhone() */
const formatPhoneJid = (phone) => {
  const clean = normalizePhone(phone);
  if (clean.length === 10) return `91${clean}@s.whatsapp.net`;
  if (clean.startsWith("91") && clean.length === 12) {
    return `${clean}@s.whatsapp.net`;
  }
  return `${clean}@s.whatsapp.net`;
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send text like KwikTeach /send-message — works for new numbers when session is healthy.
 * Also verifies the number exists on WhatsApp so we don't fake "OTP sent".
 */
const sendWhatsAppText = async (phone, message) => {
  if (connectionStatus !== "connected" || !sock) {
    throw new Error("WhatsApp is not connected. Scan QR in admin panel.");
  }

  const digits = normalizePhone(phone);
  let jid = formatPhoneJid(digits);

  // Confirm number is on WhatsApp (avoids silent fake success)
  try {
    const results = await sock.onWhatsApp(digits);
    const hit = Array.isArray(results)
      ? results.find((r) => r?.exists)
      : null;
    if (!hit) {
      const err = new Error(
        "This mobile number is not registered on WhatsApp."
      );
      err.code = "WA_NOT_REGISTERED";
      throw err;
    }
    if (hit.jid) jid = hit.jid;
  } catch (err) {
    if (err.code === "WA_NOT_REGISTERED") throw err;
    console.warn("onWhatsApp check skipped:", err.message);
  }

  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
    await delay(400);
  } catch (err) {
    console.warn("presence warm-up skipped:", err.message);
  }

  const sent = await sock.sendMessage(jid, { text: message });
  console.log(`WhatsApp message sent to ${jid}`, {
    id: sent?.key?.id || null,
  });

  if (typeof syncDiskToMongoFn === "function") {
    syncDiskToMongoFn().catch(() => {});
  }

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
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  try {
    if (typeof clearAuthFn === "function") {
      await clearAuthFn();
    }
  } catch (err) {
    console.error("Clear WhatsApp auth error:", err.message);
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
