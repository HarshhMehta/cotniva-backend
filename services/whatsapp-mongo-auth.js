const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const WhatsAppAuth = require("../model/WhatsAppAuth");

const DOC_ID = "session_bundle";

/** Only these files are needed to reconnect after a Render restart. */
const isEssentialAuthFile = (file) => {
  if (file === "creds.json") return true;
  if (file.startsWith("app-state-sync-version-")) return true;
  if (file.startsWith("session-")) return true;
  if (file.startsWith("sender-key-")) return true;
  if (file.startsWith("identity-")) return true;
  if (file === "device-identity.json") return true;
  return false;
};

const isPrunableAuthFile = (file) =>
  file.startsWith("lid-") ||
  file.startsWith("app-state-sync-key-") ||
  file.startsWith("pre-key-") ||
  file.startsWith("tctoken-");

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

const keepNewest = (authDir, files, keep) => {
  if (files.length <= keep) return 0;
  const ranked = files
    .map((file) => {
      try {
        const st = fs.statSync(path.join(authDir, file));
        return { file, mtime: st.mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const row of ranked.slice(keep)) {
    try {
      fs.unlinkSync(path.join(authDir, row.file));
      removed += 1;
    } catch (_) {}
  }
  return removed;
};

/**
 * LID + rotating app-state keys explode into thousands of files and
 * huge Mongo writes. Keep a small working set on disk.
 */
const pruneAuthDir = (authDir) => {
  if (!fs.existsSync(authDir)) return { removed: 0 };
  const names = fs.readdirSync(authDir).filter((f) => f.endsWith(".json"));
  let removed = 0;

  const lids = names.filter((f) => f.startsWith("lid-"));
  const appKeys = names.filter((f) => f.startsWith("app-state-sync-key-"));
  const preKeys = names.filter((f) => f.startsWith("pre-key-"));
  const tcTokens = names.filter((f) => f.startsWith("tctoken-"));

  for (const file of lids) {
    try {
      fs.unlinkSync(path.join(authDir, file));
      removed += 1;
    } catch (_) {}
  }
  removed += keepNewest(authDir, appKeys, 8);
  removed += keepNewest(authDir, preKeys, 20);
  removed += keepNewest(authDir, tcTokens, 2);

  if (removed > 0) {
    console.log(`WhatsApp auth pruned ${removed} cache files`);
  }
  return { removed };
};

const readEssentialAuthFiles = (authDir) => {
  if (!fs.existsSync(authDir)) return {};
  const out = {};
  for (const file of fs.readdirSync(authDir)) {
    if (!file.endsWith(".json") || !isEssentialAuthFile(file)) continue;
    try {
      out[file] = JSON.parse(
        fs.readFileSync(path.join(authDir, file), "utf8")
      );
    } catch (_) {}
  }
  return out;
};

const writeAuthDirFiles = (authDir, files) => {
  ensureDir(authDir);
  for (const [file, data] of Object.entries(files || {})) {
    if (!file.endsWith(".json") || data == null) continue;
    if (isPrunableAuthFile(file)) continue;
    fs.writeFileSync(path.join(authDir, file), JSON.stringify(data), "utf8");
  }
};

const useHybridAuthState = async (authDir) => {
  await waitForMongo();
  ensureDir(authDir);
  pruneAuthDir(authDir);

  const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

  try {
    const doc = await WhatsAppAuth.findById(DOC_ID).lean();
    const files = doc?.data?.files;
    if (files && typeof files === "object" && Object.keys(files).length > 0) {
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
      pruneAuthDir(authDir);
      const files = readEssentialAuthFiles(authDir);
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
          JSON.stringify(creds, BufferJSON.replacer)
        );
        console.log("WhatsApp legacy creds restored to disk");
      }
    }
  } catch (_) {}

  let syncTimer = null;
  const saveCredsAndSync = async () => {
    await saveCreds();
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncDiskToMongo().catch(() => {});
    }, 8000);
  };

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
  pruneAuthDir,
  useMongoAuthState: useHybridAuthState,
};
