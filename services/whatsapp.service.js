const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const pino = require("pino");
const { useHybridAuthState } = require("./whatsapp-mongo-auth");

const AUTH_DIR = path.join(__dirname, "..", "whatsapp-auth");

let sock = null;
let latestQr = null;
let connectionStatus = "disconnected"; // disconnected | qr | connecting | connected | replaced
let connectedNumber = null;
let startPromise = null;
let clearAuthFn = null;
let retries = 0;
let reconnectTimer = null;
let connectedAt = 0;
let intentionalStop = false;
/** Another WhatsApp client (Render / Web / second npm start) owns this session */
let sessionTakenElsewhere = false;

const isAutoStartEnabled = () =>
  String(process.env.WHATSAPP_AUTO_START || "true").toLowerCase() !== "false";

const ensureAuthDir = () => {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
};

const getBaileys = () => require("@whiskeysockets/baileys");

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const endSocketQuietly = (socket) => {
  if (!socket) return;
  try {
    socket.ev?.removeAllListeners?.();
  } catch (_) {}
  try {
    socket.end?.(undefined);
  } catch (_) {}
  try {
    socket.ws?.close?.();
  } catch (_) {}
};

const scheduleReconnect = (fn, delayMs) => {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    fn();
  }, delayMs);
};

const startWhatsApp = async (opts = {}) => {
  const force = Boolean(opts.force);
  if (force) {
    sessionTakenElsewhere = false;
    intentionalStop = false;
  }
  if (intentionalStop && !force) return null;
  if (sessionTakenElsewhere && !force) {
    connectionStatus = "replaced";
    return null;
  }

  // Never open a second socket while one is alive / connecting
  if (
    sock &&
    (connectionStatus === "connected" ||
      connectionStatus === "qr" ||
      connectionStatus === "connecting")
  ) {
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

    // Tear down any leftover socket before opening a new one
    if (sock) {
      endSocketQuietly(sock);
      sock = null;
    }

    const { state, saveCreds, clearAuth } = await useHybridAuthState(AUTH_DIR);
    clearAuthFn = clearAuth;

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
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = "qr";
        sessionTakenElsewhere = false;
        try {
          latestQr = await qrcode.toDataURL(qr, { width: 300, margin: 1 });
        } catch (err) {
          console.error("QR generate error:", err.message);
          latestQr = null;
        }
      }

      if (connection === "open") {
        connectionStatus = "connected";
        sessionTakenElsewhere = false;
        latestQr = null;
        connectedNumber =
          sock?.user?.id?.split(":")?.[0] || sock?.user?.id || null;
        connectedAt = Date.now();
        retries = 0;
        clearReconnectTimer();
        console.log("WhatsApp connected:", connectedNumber);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const restartRequired =
          statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const replaced =
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === 440;

        const wasConnectedLongEnough =
          connectedAt > 0 && Date.now() - connectedAt > 20000;

        connectionStatus = "disconnected";
        connectedNumber = null;
        latestQr = null;
        const closingSock = sock;
        sock = null;
        startPromise = null;
        connectedAt = 0;

        endSocketQuietly(closingSock);

        if (intentionalStop) {
          console.log("WhatsApp closed (intentional stop)");
          return;
        }

        // 440 = another client took this session (Render + local, or WhatsApp Web).
        // Reconnecting fights the other client forever — stop until admin force-starts.
        if (replaced) {
          sessionTakenElsewhere = true;
          connectionStatus = "replaced";
          clearReconnectTimer();
          retries = 0;
          console.warn(
            "WhatsApp session taken by another client (code 440). " +
              "Auto-reconnect stopped. Keep WhatsApp on ONE server only " +
              "(set WHATSAPP_AUTO_START=false on local). " +
              "Admin can force reconnect from WhatsApp settings."
          );
          return;
        }

        if (loggedOut) {
          console.log("WhatsApp logged out — clearing persisted auth");
          if (typeof clearAuthFn === "function") {
            clearAuthFn().catch((e) =>
              console.error("Clear WhatsApp auth:", e.message)
            );
          }
          retries = 0;
          scheduleReconnect(() => {
            startWhatsApp({ force: true }).catch((e) =>
              console.error("WhatsApp restart failed:", e.message)
            );
          }, 4000);
          return;
        }

        if (wasConnectedLongEnough) {
          retries = 0;
        }

        if (retries >= 8) {
          console.error(
            "WhatsApp reconnect gave up after 8 attempts. Scan QR in admin if needed."
          );
          return;
        }

        retries += 1;
        const base = restartRequired ? 1500 : 3000;
        const delay = Math.min(base * retries, 60000);
        console.log(
          `WhatsApp disconnected (code ${statusCode || "unknown"}), reconnecting in ${delay}ms (attempt ${retries})...`
        );
        scheduleReconnect(() => {
          startWhatsApp().catch((e) =>
            console.error("WhatsApp reconnect failed:", e.message)
          );
        }, delay);
      }
    });

    return sock;
  })();

  try {
    return await startPromise;
  } catch (err) {
    startPromise = null;
    connectionStatus = "disconnected";
    throw err;
  }
};

const getStatus = () => ({
  status: connectionStatus,
  qr: latestQr,
  number: connectedNumber,
  sessionTakenElsewhere,
  autoStart: isAutoStartEnabled(),
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
 * Ensure the socket has actually reached the open state.
 * startWhatsApp() creates a socket before Baileys finishes connecting, so
 * callers must not treat its resolved promise as a connected session.
 */
const waitForWhatsAppConnected = async (timeoutMs = 15000) => {
  if (connectionStatus === "connected" && sock) return true;

  try {
    await startWhatsApp();
  } catch (err) {
    console.error("WhatsApp start while waiting failed:", err.message);
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (connectionStatus === "connected" && sock) return true;
    // A QR means the saved session is no longer usable and needs admin action.
    if (connectionStatus === "qr") return false;
    await delay(250);
  }

  return connectionStatus === "connected" && !!sock;
};

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

  const sent = await sock.sendMessage(jid, { text: message });
  console.log(`WhatsApp message sent to ${jid}`, {
    id: sent?.key?.id || null,
  });

  return true;
};

const logoutWhatsApp = async () => {
  intentionalStop = true;
  clearReconnectTimer();
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (_) {}
      endSocketQuietly(sock);
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
  connectedAt = 0;

  try {
    if (typeof clearAuthFn === "function") {
      await clearAuthFn();
    }
  } catch (err) {
    console.error("Clear WhatsApp auth error:", err.message);
  }

  intentionalStop = false;
  sessionTakenElsewhere = false;
  scheduleReconnect(() => {
    startWhatsApp({ force: true }).catch((e) =>
      console.error("WhatsApp restart after logout failed:", e.message)
    );
  }, 2000);
};

module.exports = {
  startWhatsApp,
  getStatus,
  sendWhatsAppText,
  waitForWhatsAppConnected,
  logoutWhatsApp,
  normalizePhone,
  isAutoStartEnabled,
  AUTH_DIR,
};
