const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const WhatsAppAuth = require("../model/WhatsAppAuth");

const fixKey = (key) =>
  String(key || "")
    .replace(/\//g, "__")
    .replace(/:/g, "-")
    .replace(/\.json$/i, "");

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

/**
 * Baileys auth state backed by MongoDB (survives process restarts).
 * Mirrors useMultiFileAuthState API.
 */
const useMongoAuthState = async (authDirForMigration) => {
  await waitForMongo();

  const {
    initAuthCreds,
    BufferJSON,
    proto,
  } = require("@whiskeysockets/baileys");

  const writeData = async (data, id) => {
    const _id = fixKey(id);
    const payload = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await WhatsAppAuth.findOneAndUpdate(
      { _id },
      { $set: { data: payload } },
      { upsert: true, new: true }
    );
  };

  const readData = async (id) => {
    const doc = await WhatsAppAuth.findById(fixKey(id)).lean();
    if (!doc?.data) return null;
    return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
  };

  const removeData = async (id) => {
    await WhatsAppAuth.deleteOne({ _id: fixKey(id) });
  };

  // One-time migrate from local whatsapp-auth/ if Mongo is empty
  let creds = await readData("creds");
  if (!creds && authDirForMigration && fs.existsSync(authDirForMigration)) {
    try {
      const files = fs.readdirSync(authDirForMigration);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = fs.readFileSync(
          path.join(authDirForMigration, file),
          "utf8"
        );
        const parsed = JSON.parse(raw, BufferJSON.reviver);
        await writeData(parsed, file);
      }
      creds = await readData("creds");
      if (creds) {
        console.log(
          "WhatsApp auth migrated from disk → MongoDB (survives restarts)"
        );
      }
    } catch (err) {
      console.error("WhatsApp auth migrate error:", err.message);
    }
  }

  if (!creds) creds = initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeData(creds, "creds"),
    clearAuth: async () => {
      await WhatsAppAuth.deleteMany({});
    },
  };
};

module.exports = {
  useMongoAuthState,
  waitForMongo,
};
