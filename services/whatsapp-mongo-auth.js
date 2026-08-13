const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const WhatsAppAuth = require("../model/WhatsAppAuth");

const DOC_ID = "session_bundle";

/** Files needed to reconnect after a restart. */
const isEssentialAuthFile = (file) => {
  if (file === "creds.json") return true;
  if (file.startsWith("app-state-sync-version-")) return true;
  if (file.startsWith("session-")) return true;
  if (file.startsWith("sender-key-")) return true;
  if (file.startsWith("identity-")) return true;
  if (file === "device-identity.json") return true;
  // Keep a slice of LIDs / pre-keys so reconnect stays stable
  if (file.startsWith("lid-")) return true;
  if (file.startsWith("pre-key-")) return true;
  if (file.startsWith("app-state-sync-key-")) return true;
  return false;
};

const isPrunableAuthFile = (file) =>
  file.startsWith("tctoken-");

const writeAuthDirFiles = (authDir, files) => {
  ensureDir(authDir);
  for (const [file, data] of Object.entries(files || {})) {
    if (!file.endsWith(".json") || data == null) continue;
    if (isPrunableAuthFile(file)) continue;
    fs.writeFileSync(path.join(authDir, file), JSON.stringify(data), "utf8");
  }
};

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
 * Trim bulky rotating keys. Never wipe all LID / identity material —
 * aggressive deletes cause Baileys connect→disconnect loops.
 */
const pruneAuthDir = (authDir, { aggressive = false } = {}) => {
  if (!fs.existsSync(authDir)) return { removed: 0 };
  const names = fs.readdirSync(authDir).filter((f) => f.endsWith(".json"));
  let removed = 0;

  const lids = names.filter((f) => f.startsWith("lid-"));
  const appKeys = names.filter((f) => f.startsWith("app-state-sync-key-"));
  const preKeys = names.filter((f) => f.startsWith("pre-key-"));
  const tcTokens = names.filter((f) => f.startsWith("tctoken-"));

  // Keep a working set of LIDs — deleting all of them breaks modern Baileys
  removed += keepNewest(authDir, lids, aggressive ? 40 : 120);
  removed += keepNewest(authDir, appKeys, aggressive ? 12 : 24);
  removed += keepNewest(authDir, preKeys, aggressive ? 30 : 60);
  removed += keepNewest(authDir, tcTokens, 4);

  if (removed > 0) {
    console.log(`WhatsApp auth pruned ${removed} cache files`);
  }
  return { removed };
};

const readEssentialAuthFiles = (authDir) => {
  if (!fs.existsSync(authDir)) return {};
  const out = {};
  const lids = [];
  const preKeys = [];
  const appKeys = [];

  for (const file of fs.readdirSync(authDir)) {
    if (!file.endsWith(".json") || !isEssentialAuthFile(file)) continue;
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(authDir, file), "utf8")
      );
      if (file.startsWith("lid-")) lids.push({ file, data });
      else if (file.startsWith("pre-key-")) preKeys.push({ file, data });
      else if (file.startsWith("app-state-sync-key-"))
        appKeys.push({ file, data });
      else out[file] = data;
    } catch (_) {}
  }

  const byMtime = (a, b) => {
    try {
      return (
        fs.statSync(path.join(authDir, b.file)).mtimeMs -
        fs.statSync(path.join(authDir, a.file)).mtimeMs
      );
    } catch {
      return 0;
    }
  };

  lids.sort(byMtime).slice(0, 80).forEach((row) => {
    out[row.file] = row.data;
  });
  preKeys.sort(byMtime).slice(0, 40).forEach((row) => {
    out[row.file] = row.data;
  });
  appKeys.sort(byMtime).slice(0, 16).forEach((row) => {
    out[row.file] = row.data;
  });

  return out;
};

const useHybridAuthState = async (authDir) => {
  await waitForMongo();
  ensureDir(authDir);
  // One light prune on boot only — never mid-session
  pruneAuthDir(authDir, { aggressive: false });

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

  const syncDiskToMongo = async ({ prune = false } = {}) => {
    try {
      if (prune) pruneAuthDir(authDir, { aggressive: false });
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
    // Debounced Mongo backup — do NOT prune keys while session is live
    syncTimer = setTimeout(() => {
      syncDiskToMongo({ prune: false }).catch(() => {});
    }, 12000);
  };

  // Initial backup without pruning again
  await syncDiskToMongo({ prune: false });

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
