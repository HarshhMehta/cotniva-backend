const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const WhatsAppAuth = require("../model/WhatsAppAuth");

const DOC_ID = "session_bundle";

const waitForMongo = async (timeoutMs = 45000) => {
  if (mongoose.connection.readyState === 1) return;
  if (mongoose.connection.readyState === 2) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("MongoDB connect timeout for WhatsApp auth")),
        timeoutMs
      );
      mongoose.connection.once("connected", () => {
        clearTimeout(t);
        resolve();
      });
      mongoose.connection.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    return;
  }
  throw new Error("MongoDB is not connected — cannot restore WhatsApp session");
};

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

/**
 * Read all *.json files in auth dir → { filename: parsedObject }
 */
const readAuthDirFiles = (authDir) => {
  if (!fs.existsSync(authDir)) return {};
  const out = {};
  for (const file of fs.readdirSync(authDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out[file] = JSON.parse(
        fs.readFileSync(path.join(authDir, file), "utf8")
      );
    } catch (_) {}
  }
  return out;
};

/**
 * Write file map back to auth dir (for restore on boot).
 */
const writeAuthDirFiles = (authDir, files) => {
  ensureDir(authDir);
  for (const [file, data] of Object.entries(files || {})) {
    if (!file.endsWith(".json") || data == null) continue;
    fs.writeFileSync(
      path.join(authDir, file),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  }
};

/**
 * KwikTeach-compatible auth:
 * - Baileys uses normal useMultiFileAuthState (same send path that works for unknown numbers)
 * - We mirror the whole session folder into Mongo so Render restarts keep the QR session
 */
const useHybridAuthState = async (authDir) => {
  await waitForMongo();
  ensureDir(authDir);

  const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

  // Restore from Mongo → disk before Baileys opens the folder
  try {
    const doc = await WhatsAppAuth.findById(DOC_ID).lean();
    const files = doc?.data?.files;
    if (files && typeof files === "object" && Object.keys(files).length > 0) {
      // Only restore if disk is empty / missing creds
      const diskCreds = path.join(authDir, "creds.json");
      if (!fs.existsSync(diskCreds)) {
        writeAuthDirFiles(authDir, files);
        console.log(
          `WhatsApp session restored from Mongo (${Object.keys(files).length} files)`
        );
      }
    }
  } catch (err) {
    console.error("WhatsApp Mongo restore error:", err.message);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const syncDiskToMongo = async () => {
    try {
      const files = readAuthDirFiles(authDir);
      await WhatsAppAuth.findOneAndUpdate(
        { _id: DOC_ID },
        {
          $set: {
            data: { files, updatedAt: new Date().toISOString() },
          },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error("WhatsApp Mongo sync error:", err.message);
    }
  };

  // Migrate old per-key Mongo auth → disk once, if needed
  try {
    const diskCreds = path.join(authDir, "creds.json");
    if (!fs.existsSync(diskCreds)) {
      const credsDoc = await WhatsAppAuth.findById("creds").lean();
      if (credsDoc?.data) {
        const { BufferJSON } = require("@whiskeysockets/baileys");
        const creds = JSON.parse(
          JSON.stringify(credsDoc.data),
          BufferJSON.reviver
        );
        fs.writeFileSync(
          path.join(authDir, "creds.json"),
          JSON.stringify(creds, BufferJSON.replacer, 2)
        );
        console.log("WhatsApp legacy creds restored to disk");
      }
    }
  } catch (_) {}

  const saveCredsAndSync = async () => {
    await saveCreds();
    await syncDiskToMongo();
  };

  // Initial sync so Mongo has a copy even before first creds.update
  await syncDiskToMongo();

  const clearAuth = async () => {
    try {
      await WhatsAppAuth.deleteMany({});
    } catch (_) {}
    try {
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    } catch (_) {}
    ensureDir(authDir);
  };

  return {
    state,
    saveCreds: saveCredsAndSync,
    syncDiskToMongo,
    clearAuth,
  };
};

module.exports = {
  useHybridAuthState,
  waitForMongo,
  // keep old name exported for safety
  useMongoAuthState: useHybridAuthState,
};
