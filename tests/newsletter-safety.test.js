#!/usr/bin/env node
/**
 * Newsletter subscription / campaign safety tests (in-memory fakes; no DB / SMTP).
 * Run: node tests/newsletter-safety.test.js
 */
const assert = require("assert");
const Module = require("module");
const path = require("path");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const originalLoad = Module._load;
const subscribers = new Map();
const campaigns = new Map();
const mails = [];

const clone = (v) => {
  if (v == null) return v;
  if (v instanceof Date) return new Date(v);
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v === "object") {
    if (v._bsontype === "ObjectID" || v instanceof ObjectId) {
      return new ObjectId(String(v));
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = clone(val);
    return out;
  }
  return v;
};
const idStr = (v) => (v == null ? "" : String(v));

function matchesFilter(doc, filter) {
  if (!filter || !Object.keys(filter).length) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (k === "$and") {
      if (!v.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    let cur = doc;
    for (const p of String(k).split(".")) {
      if (cur == null) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(v, "$regex")) {
        const re = new RegExp(v.$regex, v.$options || "");
        if (!re.test(String(cur || ""))) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(v, "$gt")) {
        if (!(cur > v.$gt)) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(v, "$ne")) {
        if (idStr(cur) === idStr(v.$ne) || (cur == null && v.$ne == null)) {
          // $ne null means field must not be null
        }
        if (v.$ne === null) {
          if (cur == null) return false;
        } else if (idStr(cur) === idStr(v.$ne)) {
          return false;
        }
        continue;
      }
      continue;
    }
    if (idStr(cur) !== idStr(v)) return false;
  }
  return true;
}

function makeChain(list) {
  const state = { skipN: 0, limitN: null, selectFields: null };
  const api = {
    select(fields) {
      state.selectFields = fields;
      return api;
    },
    sort() {
      return api;
    },
    skip(n) {
      state.skipN = n;
      return api;
    },
    limit(n) {
      state.limitN = n;
      return api;
    },
    lean() {
      let out = list.slice(
        state.skipN,
        state.limitN == null ? undefined : state.skipN + state.limitN
      );
      return Promise.resolve(out.map(clone));
    },
    then(resolve, reject) {
      return api.lean().then(resolve, reject);
    },
  };
  return api;
}

function FakeDoc(data) {
  Object.assign(this, clone(data));
  this._id = this._id || new ObjectId();
}
FakeDoc.prototype.issueVerifyToken = function () {
  const token = `verify_${idStr(this._id)}_${Date.now()}`;
  this.verifyToken = token;
  this.verifyTokenExpires = new Date(Date.now() + 2 * 86400000);
  return token;
};
FakeDoc.prototype.ensureUnsubscribeToken = function () {
  if (!this.unsubscribeToken) {
    this.unsubscribeToken = `unsub_${idStr(this._id)}`;
  }
  return this.unsubscribeToken;
};
FakeDoc.prototype.save = async function () {
  subscribers.set(idStr(this._id), clone(this));
  return this;
};

const FakeSubscriber = {
  findOne(filter) {
    for (const doc of subscribers.values()) {
      if (matchesFilter(doc, filter)) {
        return Promise.resolve(new FakeDoc(doc));
      }
    }
    return Promise.resolve(null);
  },
  find(filter) {
    const list = [...subscribers.values()].filter((d) =>
      matchesFilter(d, filter)
    );
    return makeChain(list);
  },
  countDocuments(filter) {
    return Promise.resolve(
      [...subscribers.values()].filter((d) => matchesFilter(d, filter)).length
    );
  },
};

const FakeCampaign = {
  async create(data) {
    const doc = {
      ...clone(data),
      _id: new ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      failures: data.failures || [],
    };
    campaigns.set(idStr(doc._id), doc);
    const api = {
      ...doc,
      async save() {
        campaigns.set(idStr(this._id), clone(this));
        return this;
      },
    };
    return api;
  },
  findById(id) {
    const doc = campaigns.get(idStr(id));
    if (!doc) return Promise.resolve(null);
    const api = {
      ...clone(doc),
      async save() {
        campaigns.set(idStr(this._id), clone(this));
        return this;
      },
    };
    return Promise.resolve(api);
  },
  findOne(filter) {
    let found = null;
    for (const doc of campaigns.values()) {
      if (matchesFilter(doc, filter)) {
        found = clone(doc);
        break;
      }
    }
    const api = {
      select() {
        return api;
      },
      lean() {
        return Promise.resolve(found);
      },
      then(resolve, reject) {
        return Promise.resolve(found).then(resolve, reject);
      },
    };
    return api;
  },
  find(filter) {
    const list = [...campaigns.values()].filter((d) => matchesFilter(d, filter));
    return makeChain(list);
  },
  countDocuments(filter) {
    return Promise.resolve(
      [...campaigns.values()].filter((d) => matchesFilter(d, filter)).length
    );
  },
  findByIdAndUpdate(id, update) {
    const doc = campaigns.get(idStr(id));
    if (!doc) return Promise.resolve(null);
    if (update.$set) Object.assign(doc, update.$set);
    campaigns.set(idStr(id), doc);
    return Promise.resolve(clone(doc));
  },
};

Module._load = function (request, parent, isMain) {
  if (request.endsWith("/model/NewsletterSubscriber") || request === "../model/NewsletterSubscriber") {
    return function NewsletterSubscriber(data) {
      return new FakeDoc(data);
    };
  }
  // Can't easily replace constructor + statics — use path match below
  return originalLoad(request, parent, isMain);
};

// More reliable: patch after requiring via absolute path overrides
const modelSubPath = path.join(
  __dirname,
  "../model/NewsletterSubscriber.js"
);
const modelCampPath = path.join(__dirname, "../model/NewsletterCampaign.js");
const emailSvcPath = path.join(
  __dirname,
  "../services/newsletter-email.service.js"
);
const emailCfgPath = path.join(__dirname, "../config/email.js");
const secretPath = path.join(__dirname, "../config/secret.js");

Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try {
      return Module._resolveFilename(request, parent);
    } catch {
      return request;
    }
  })();

  if (resolved === modelSubPath || request.includes("NewsletterSubscriber")) {
    const Ctor = function (data) {
      return new FakeDoc(data);
    };
    Object.assign(Ctor, FakeSubscriber);
    return Ctor;
  }
  if (resolved === modelCampPath || request.includes("NewsletterCampaign")) {
    return FakeCampaign;
  }
  if (resolved === emailSvcPath || request.includes("newsletter-email.service")) {
    return {
      CONCURRENCY: 2,
      sendVerificationEmail: async ({ email, verifyToken }) => {
        mails.push({ type: "verify", to: email, verifyToken });
      },
      sendCampaignEmail: async ({ email, subject, content }) => {
        if (String(email).includes("fail@")) {
          throw new Error("SMTP failed");
        }
        mails.push({ type: "campaign", to: email, subject, content });
      },
      mapWithConcurrency: async (items, limit, worker) => {
        const results = { sent: 0, failed: 0, failures: [] };
        for (const item of items) {
          try {
            await worker(item);
            results.sent += 1;
          } catch (err) {
            results.failed += 1;
            results.failures.push({
              email: item.email,
              error: err.message,
              at: new Date(),
            });
          }
        }
        return results;
      },
    };
  }
  if (resolved === emailCfgPath) {
    return {
      sendMailAsync: async (mail) => {
        mails.push(mail);
        return { messageId: "test" };
      },
    };
  }
  if (resolved === secretPath) {
    return {
      secret: {
        client_url: "https://store.test",
        email_user: "noreply@test",
        admin_order_email: "admin@cotniva.test",
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const controller = require("../controller/newsletter.controller");
const {
  normalizeEmail,
  isValidEmail,
  processCampaign,
} = controller._internals;

controller._internals.setScheduleCampaignSend(() => {});

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function run() {
  console.log("newsletter-safety: start");

  // 1. Email normalize / validate
  assert.strictEqual(normalizeEmail("  A@B.Com "), "a@b.com");
  assert.ok(isValidEmail("hello@cotniva.com"));
  assert.ok(!isValidEmail("not-an-email"));
  assert.ok(!isValidEmail(""));

  // 2. Invalid subscribe
  {
    const res = mockRes();
    await controller.subscribe({ body: { email: "bad" } }, res, (e) => {
      throw e;
    });
    assert.strictEqual(res.statusCode, 400);
  }

  // 3. New subscription → active immediately, no verification email
  mails.length = 0;
  subscribers.clear();
  {
    const res = mockRes();
    await controller.subscribe(
      { body: { email: "New@Cotniva.com" } },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.strictEqual(res.body.alreadySubscribed, false);
    assert.ok(!/check your inbox/i.test(res.body.message || ""));
    assert.strictEqual(mails.length, 0);
    const sub = [...subscribers.values()][0];
    assert.strictEqual(sub.subscribed, true);
    assert.strictEqual(sub.verified, true);
    assert.ok(sub.subscribedAt);
    assert.ok(sub.unsubscribeToken);
    assert.strictEqual(sub.verifyToken, null);
  }

  // 4. Duplicate while already subscribed
  mails.length = 0;
  {
    const res = mockRes();
    await controller.subscribe(
      { body: { email: "new@cotniva.com" } },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.alreadySubscribed, true);
    assert.strictEqual(mails.length, 0);
    assert.strictEqual([...subscribers.values()].length, 1);
  }

  // 5. Unsubscribe
  {
    const sub = [...subscribers.values()][0];
    const res = mockRes();
    await controller.unsubscribe(
      { params: { token: sub.unsubscribeToken } },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.statusCode, 200);
    const updated = [...subscribers.values()][0];
    assert.strictEqual(updated.subscribed, false);
    assert.ok(updated.unsubscribedAt);
  }

  // 6. Re-subscribe after unsubscribe → active again, no verify email
  mails.length = 0;
  {
    const res = mockRes();
    await controller.subscribe(
      { body: { email: "new@cotniva.com" } },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.body.alreadySubscribed, false);
    assert.strictEqual(mails.length, 0);
    const sub = [...subscribers.values()][0];
    assert.strictEqual(sub.subscribed, true);
    assert.strictEqual(sub.unsubscribedAt, null);
  }

  // 7. Campaign skips unsubscribed + inactive; includes subscribed without verified flag
  {
    // Add active + unsubscribed
    const activeId = new ObjectId();
    const unsubId = new ObjectId();
    subscribers.clear();
    subscribers.set(idStr(activeId), {
      _id: activeId,
      email: "active@cotniva.com",
      subscribed: true,
      verified: true,
      unsubscribeToken: "u1",
    });
    subscribers.set(idStr(unsubId), {
      _id: unsubId,
      email: "gone@cotniva.com",
      subscribed: false,
      verified: true,
      unsubscribedAt: new Date(),
      unsubscribeToken: "u2",
    });
    subscribers.set(idStr(new ObjectId()), {
      _id: new ObjectId(),
      email: "legacy-active@cotniva.com",
      subscribed: true,
      verified: false,
      unsubscribeToken: "u4",
    });
    subscribers.set(idStr(new ObjectId()), {
      _id: new ObjectId(),
      email: "pending@cotniva.com",
      subscribed: false,
      verified: false,
      unsubscribeToken: "u3",
    });

    const resNoConfirm = mockRes();
    await controller.adminSendCampaign(
      {
        body: { subject: "Hi", content: "Hello", confirm: false },
        user: { _id: new ObjectId(), email: "admin@cotniva.test" },
      },
      resNoConfirm,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(resNoConfirm.statusCode, 400);

    mails.length = 0;
    campaigns.clear();
    const res = mockRes();
    await controller.adminSendCampaign(
      {
        body: { subject: "Drop", content: "New kurtis", confirm: true },
        user: { _id: new ObjectId(), email: "admin@cotniva.test" },
      },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.data.recipientCount, 2);

    // Process campaign manually
    const campId = res.body.data.campaignId;
    await processCampaign(campId);
    const tos = mails.map((m) => m.to).sort();
    assert.deepStrictEqual(tos, [
      "active@cotniva.com",
      "legacy-active@cotniva.com",
    ]);
    assert.ok(!mails.some((m) => m.to === "gone@cotniva.com"));
    assert.ok(!mails.some((m) => m.to === "pending@cotniva.com"));
    const camp = campaigns.get(idStr(campId));
    assert.strictEqual(camp.status, "completed");
    assert.strictEqual(camp.sentCount, 2);
  }

  // 10. Duplicate campaign while sending blocked
  {
    campaigns.clear();
    const sendingId = new ObjectId();
    campaigns.set(idStr(sendingId), {
      _id: sendingId,
      status: "sending",
      isTest: false,
      subject: "Busy",
    });
    const res = mockRes();
    await controller.adminSendCampaign(
      {
        body: { subject: "Another", content: "X", confirm: true },
        user: { _id: new ObjectId(), email: "admin@cotniva.test" },
      },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.statusCode, 409);
  }

  // 11. Failed send counted, not as success
  {
    campaigns.clear();
    subscribers.clear();
    const failId = new ObjectId();
    subscribers.set(idStr(failId), {
      _id: failId,
      email: "fail@cotniva.com",
      subscribed: true,
      verified: true,
      unsubscribeToken: "uf",
    });
    const camp = await FakeCampaign.create({
      subject: "X",
      content: "Y",
      status: "sending",
      isTest: false,
      recipientCount: 1,
      sentCount: 0,
      failedCount: 0,
    });
    await processCampaign(camp._id);
    const updated = campaigns.get(idStr(camp._id));
    assert.strictEqual(updated.sentCount, 0);
    assert.strictEqual(updated.failedCount, 1);
    assert.strictEqual(updated.status, "failed");
  }

  // 12. Test email only to admin
  {
    mails.length = 0;
    campaigns.clear();
    const res = mockRes();
    await controller.adminSendTest(
      {
        body: { subject: "Test", content: "Ping" },
        user: { _id: new ObjectId(), email: "admin@cotniva.test" },
      },
      res,
      (e) => {
        throw e;
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(mails[0].to, "admin@cotniva.test");
  }

  // 13. Resend blocked
  {
    const res = mockRes();
    await controller.adminResendBlocked({}, res);
    assert.strictEqual(res.statusCode, 405);
  }

  console.log("newsletter-safety: all passed");
}

run().catch((err) => {
  console.error("newsletter-safety FAILED:", err);
  process.exit(1);
});
