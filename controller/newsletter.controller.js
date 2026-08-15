const NewsletterSubscriber = require("../model/NewsletterSubscriber");
const NewsletterCampaign = require("../model/NewsletterCampaign");
const {
  sendCampaignEmail,
  mapWithConcurrency,
  CONCURRENCY,
} = require("../services/newsletter-email.service");
const { secret } = require("../config/secret");

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const normalizeEmail = (raw) =>
  String(raw || "")
    .trim()
    .toLowerCase()
    .slice(0, 254);

const isValidEmail = (email) => EMAIL_RE.test(email);

/** Active campaign recipients — subscribed immediately (no double opt-in) */
const activeFilter = {
  subscribed: true,
};

/** In-process guard so we only run one bulk campaign at a time per process */
let campaignWorkerBusy = false;

let scheduleCampaignSendImpl = (campaignId) => {
  setImmediate(() => {
    processCampaign(campaignId).catch((err) => {
      console.error("[newsletter] campaign worker crashed:", err?.message || err);
    });
  });
};

const scheduleCampaignSend = (campaignId) => {
  scheduleCampaignSendImpl(campaignId);
};

const processCampaign = async (campaignId) => {
  if (campaignWorkerBusy) {
    // Retry shortly if another worker is finishing
    setTimeout(() => scheduleCampaignSend(campaignId), 2000);
    return;
  }
  campaignWorkerBusy = true;
  try {
    const campaign = await NewsletterCampaign.findById(campaignId);
    if (!campaign || campaign.status !== "sending" || campaign.isTest) {
      return;
    }

    const recipients = await NewsletterSubscriber.find({
      ...activeFilter,
    })
      .select("email unsubscribeToken")
      .lean();

    const results = await mapWithConcurrency(
      recipients,
      CONCURRENCY,
      async (sub) => {
        await sendCampaignEmail({
          email: sub.email,
          subject: campaign.subject,
          content: campaign.content,
          unsubscribeToken: sub.unsubscribeToken,
        });
      }
    );

    const finalStatus =
      results.failed > 0 && results.sent === 0 ? "failed" : "completed";

    await NewsletterCampaign.findByIdAndUpdate(campaignId, {
      $set: {
        sentCount: results.sent,
        failedCount: results.failed,
        failures: results.failures.slice(0, 100),
        status: finalStatus,
        completedAt: new Date(),
        recipientCount: recipients.length,
      },
    });
  } catch (err) {
    await NewsletterCampaign.findByIdAndUpdate(campaignId, {
      $set: {
        status: "failed",
        completedAt: new Date(),
        failures: [
          {
            email: "",
            error: err?.message || String(err),
            at: new Date(),
          },
        ],
      },
    }).catch(() => {});
  } finally {
    campaignWorkerBusy = false;
  }
};

/** POST /api/newsletter/subscribe — immediate subscribe (no verification email) */
exports.subscribe = async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    let subscriber = await NewsletterSubscriber.findOne({ email });

    if (subscriber?.subscribed) {
      return res.status(200).json({
        success: true,
        alreadySubscribed: true,
        message: "You’re already on the list. Welcome back.",
      });
    }

    if (!subscriber) {
      subscriber = new NewsletterSubscriber({ email });
    }

    subscriber.subscribed = true;
    subscriber.verified = true; // legacy field; kept in sync for older records
    subscriber.subscribedAt = new Date();
    subscriber.unsubscribedAt = null;
    subscriber.verifyToken = null;
    subscriber.verifyTokenExpires = null;
    subscriber.ensureUnsubscribeToken();
    await subscriber.save();

    return res.status(200).json({
      success: true,
      alreadySubscribed: false,
      message: "You’re in! New drops are coming your way.",
    });
  } catch (error) {
    if (error?.code === 11000) {
      // Race on unique email — treat as already subscribed if active
      const existing = await NewsletterSubscriber.findOne({
        email: normalizeEmail(req.body?.email),
      }).catch(() => null);
      if (existing?.subscribed) {
        return res.status(200).json({
          success: true,
          alreadySubscribed: true,
          message: "You’re already on the list. Welcome back.",
        });
      }
      return res.status(200).json({
        success: true,
        alreadySubscribed: false,
        message: "You’re in! New drops are coming your way.",
      });
    }
    next(error);
  }
};

/** GET /api/newsletter/verify/:token — legacy; activates if an old link is still used */
exports.verify = async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token || token.length < 16) {
      return res.status(400).json({
        success: false,
        message: "Invalid link.",
      });
    }

    const subscriber = await NewsletterSubscriber.findOne({
      verifyToken: token,
    });

    if (!subscriber) {
      return res.status(400).json({
        success: false,
        message: "This link is invalid or has already been used.",
      });
    }

    if (subscriber.subscribed) {
      subscriber.verifyToken = null;
      subscriber.verifyTokenExpires = null;
      await subscriber.save();
      return res.status(200).json({
        success: true,
        message: "You’re already on the list. Thanks for being here.",
      });
    }

    subscriber.subscribed = true;
    subscriber.verified = true;
    subscriber.subscribedAt = new Date();
    subscriber.unsubscribedAt = null;
    subscriber.verifyToken = null;
    subscriber.verifyTokenExpires = null;
    subscriber.ensureUnsubscribeToken();
    await subscriber.save();

    return res.status(200).json({
      success: true,
      message: "You’re in! New drops are coming your way.",
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/newsletter/unsubscribe/:token — lookup for confirmation page */
exports.getUnsubscribeInfo = async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim();
    const subscriber = await NewsletterSubscriber.findOne({
      unsubscribeToken: token,
    })
      .select("email subscribed")
      .lean();

    if (!subscriber) {
      return res.status(404).json({
        success: false,
        message: "Unsubscribe link is invalid.",
      });
    }

    const email = String(subscriber.email || "");
    const at = email.indexOf("@");
    const masked =
      at > 1
        ? `${email[0]}${"•".repeat(Math.min(6, at - 1))}${email.slice(at)}`
        : email;

    return res.status(200).json({
      success: true,
      data: {
        emailMasked: masked,
        subscribed: Boolean(subscriber.subscribed),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/newsletter/unsubscribe/:token */
exports.unsubscribe = async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim();
    const subscriber = await NewsletterSubscriber.findOne({
      unsubscribeToken: token,
    });

    if (!subscriber) {
      return res.status(404).json({
        success: false,
        message: "Unsubscribe link is invalid.",
      });
    }

    if (!subscriber.subscribed) {
      return res.status(200).json({
        success: true,
        message: "You’re already unsubscribed.",
      });
    }

    subscriber.subscribed = false;
    subscriber.unsubscribedAt = new Date();
    await subscriber.save();

    return res.status(200).json({
      success: true,
      message: "You’ve been unsubscribed. We’re sorry to see you go.",
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/newsletter/admin/stats */
exports.adminStats = async (req, res, next) => {
  try {
    const [total, active, unsubscribed] = await Promise.all([
      NewsletterSubscriber.countDocuments({}),
      NewsletterSubscriber.countDocuments(activeFilter),
      NewsletterSubscriber.countDocuments({
        subscribed: false,
        unsubscribedAt: { $ne: null },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        total,
        active,
        unsubscribed,
        pending: Math.max(0, total - active - unsubscribed),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/newsletter/admin/list */
exports.adminList = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const status = String(req.query.status || "").toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();

    const filter = {};
    if (status === "active") {
      Object.assign(filter, activeFilter);
    } else if (status === "unsubscribed") {
      filter.subscribed = false;
      filter.unsubscribedAt = { $ne: null };
    } else if (status === "pending") {
      // Legacy rows that never completed (pre single-opt-in)
      filter.subscribed = false;
      filter.unsubscribedAt = null;
    }

    if (q) {
      filter.email = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }

    const [rows, total] = await Promise.all([
      NewsletterSubscriber.find(filter)
        .select(
          "email subscribed verified subscribedAt unsubscribedAt createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      NewsletterSubscriber.countDocuments(filter),
    ]);

    const data = rows.map((row) => {
      let displayStatus = "pending";
      if (row.subscribed) displayStatus = "active";
      else if (row.unsubscribedAt) displayStatus = "unsubscribed";
      return {
        _id: row._id,
        email: row.email,
        status: displayStatus,
        subscribed: row.subscribed,
        verified: row.verified,
        subscribedAt: row.subscribedAt,
        unsubscribedAt: row.unsubscribedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/newsletter/admin/campaigns */
exports.adminCampaignList = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      NewsletterCampaign.find({})
        .select(
          "subject recipientCount sentCount failedCount status isTest createdAt completedAt createdBy"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      NewsletterCampaign.countDocuments({}),
    ]);

    res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/newsletter/admin/campaigns/test
 * Sends only to the logged-in admin's email (or ADMIN_ORDER_EMAIL fallback).
 */
exports.adminSendTest = async (req, res, next) => {
  try {
    const subject = String(req.body?.subject || "").trim().slice(0, 200);
    const content = String(req.body?.content || "").trim().slice(0, 50000);
    if (!subject || !content) {
      return res.status(400).json({
        success: false,
        message: "Subject and message are required.",
      });
    }

    const to =
      String(req.user?.email || "").trim() ||
      String(secret.admin_order_email || secret.email_user || "").trim();

    if (!to || !isValidEmail(to)) {
      return res.status(400).json({
        success: false,
        message: "No admin email available for the test send.",
      });
    }

    const campaign = await NewsletterCampaign.create({
      subject,
      content,
      recipientCount: 1,
      sentCount: 0,
      failedCount: 0,
      status: "sending",
      isTest: true,
      createdBy: req.user?._id || null,
    });

    try {
      await sendCampaignEmail({
        email: to,
        subject,
        content,
        unsubscribeToken: null,
      });
      campaign.sentCount = 1;
      campaign.status = "completed";
      campaign.completedAt = new Date();
      await campaign.save();
    } catch (err) {
      campaign.failedCount = 1;
      campaign.status = "failed";
      campaign.completedAt = new Date();
      campaign.failures = [
        { email: to, error: err?.message || String(err), at: new Date() },
      ];
      await campaign.save();
      return res.status(503).json({
        success: false,
        message: "Test email failed to send.",
        data: { campaignId: campaign._id },
      });
    }

    return res.status(200).json({
      success: true,
      message: `Test email sent to ${to}`,
      data: { campaignId: campaign._id, to },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/newsletter/admin/campaigns/send
 * Creates a campaign and sends to all active subscribers in the background.
 */
exports.adminSendCampaign = async (req, res, next) => {
  try {
    const subject = String(req.body?.subject || "").trim().slice(0, 200);
    const content = String(req.body?.content || "").trim().slice(0, 50000);
    const confirm = Boolean(req.body?.confirm);

    if (!subject || !content) {
      return res.status(400).json({
        success: false,
        message: "Subject and message are required.",
      });
    }
    if (!confirm) {
      return res.status(400).json({
        success: false,
        message: "Confirmation required before sending to all subscribers.",
      });
    }

    const sendingExisting = await NewsletterCampaign.findOne({
      status: "sending",
      isTest: false,
    })
      .select("_id")
      .lean();

    if (sendingExisting) {
      return res.status(409).json({
        success: false,
        message:
          "Another campaign is already sending. Wait for it to finish before starting a new one.",
        data: { campaignId: sendingExisting._id },
      });
    }

    const recipientCount = await NewsletterSubscriber.countDocuments(
      activeFilter
    );

    if (recipientCount === 0) {
      return res.status(400).json({
        success: false,
        message: "There are no active subscribers to email.",
      });
    }

    const campaign = await NewsletterCampaign.create({
      subject,
      content,
      recipientCount,
      sentCount: 0,
      failedCount: 0,
      status: "sending",
      isTest: false,
      createdBy: req.user?._id || null,
    });

    scheduleCampaignSend(campaign._id);

    return res.status(202).json({
      success: true,
      message: `Sending to ${recipientCount} active subscriber${
        recipientCount === 1 ? "" : "s"
      }.`,
      data: {
        campaignId: campaign._id,
        recipientCount,
        status: "sending",
      },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/newsletter/admin/campaigns/:id/retry — blocked if already completed/sending without draft */
exports.adminResendBlocked = async (req, res) => {
  return res.status(405).json({
    success: false,
    message:
      "Campaigns cannot be resent. Create a new campaign to email subscribers again.",
  });
};

// Exported for tests
exports._internals = {
  normalizeEmail,
  isValidEmail,
  activeFilter,
  processCampaign,
  scheduleCampaignSend,
  setScheduleCampaignSend(fn) {
    if (typeof fn === "function") scheduleCampaignSendImpl = fn;
  },
  EMAIL_RE,
};
