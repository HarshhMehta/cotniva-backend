require("dotenv").config();
const http = require("http");
const express = require("express");
const compression = require("compression");
const app = express();
const path = require("path");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const connectDB = require("./config/db");
const { secret } = require("./config/secret");
const PORT = secret.port || 7001;
const morgan = require("morgan");
const globalErrorHandler = require("./middleware/global-error-handler");

const userRoutes = require("./routes/user.routes");
const authRoutes = require("./routes/auth.routes");
const categoryRoutes = require("./routes/category.routes");
const brandRoutes = require("./routes/brand.routes");
const userOrderRoutes = require("./routes/user.order.routes");
const productRoutes = require("./routes/product.routes");
const orderRoutes = require("./routes/order.routes");
const couponRoutes = require("./routes/coupon.routes");
const reviewRoutes = require("./routes/review.routes");
const adminRoutes = require("./routes/admin.routes");
const cloudinaryRoutes = require("./routes/cloudinary.routes");
const sliderRoutes = require("./routes/slider.routes");
const topbarRoutes = require("./routes/topbar.routes");
const welcomePopupRoutes = require("./routes/welcome-popup.routes");
const storeSettingsRoutes = require("./routes/store-settings.routes");
const galleryRoutes = require("./routes/gallery.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");
const homeRoutes = require("./routes/home.routes");
const sizeGuideRoutes = require("./routes/sizeGuide.routes");
const notificationRoutes = require("./routes/notification.routes");
const customerRoutes = require("./routes/customer.routes");
const { startWhatsApp, isAutoStartEnabled } = require("./services/whatsapp.service");
const { razorpayWebhook } = require("./controller/order.controller");
const { startHoldExpiryJob } = require("./services/inventory.service");

const {
  getStoreOrigins,
  getAdminOrigins,
  isAllowedOrigin,
} = require("./utils/allowed-origins");

// Render / proxies terminate TLS — needed for secure cookies + req.protocol
app.set("trust proxy", 1);

app.use(
  compression({
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
    threshold: 1024,
  })
);

app.use(
  cors({
    origin(origin, cb) {
      // Same-origin / server-to-server / mobile tools
      if (!origin) return cb(null, true);

      const allowed = [...getStoreOrigins(), ...getAdminOrigins()];
      if (isAllowedOrigin(origin, allowed)) {
        // Must echo exact origin when credentials: true
        return cb(null, origin);
      }

      console.warn(`[cors] blocked origin: ${origin}`);
      return cb(null, false);
    },
    credentials: true,
  })
);
app.post(
  "/api/order/razorpay-webhook",
  express.raw({ type: "application/json" }),
  razorpayWebhook
);
// GitHub deploy webhook — must stay BEFORE express.json() so raw body is forwarded
app.post("/deploy-hook", (req, res) => {
  const proxyReq = http.request(
    {
      hostname: "localhost",
      port: 4001,
      path: "/deploy-hook",
      method: "POST",
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("Deploy proxy error:", err.message);
    res.status(502).send("Deploy service unavailable");
  });

  req.pipe(proxyReq);
});
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/product", productRoutes);
app.use("/api/order", orderRoutes);
app.use("/api/coupon", couponRoutes);
app.use("/api/user-order", userOrderRoutes);
app.use("/api/review", reviewRoutes);
app.use("/api/cloudinary", cloudinaryRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/slider", sliderRoutes);
app.use("/api/topbar", topbarRoutes);
app.use("/api/welcome-popup", welcomePopupRoutes);
app.use("/api/store-settings", storeSettingsRoutes);
app.use("/api/gallery", galleryRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/size-guide", sizeGuideRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/checkout-abandon", require("./routes/checkoutAbandon.routes"));
app.use("/api/newsletter", require("./routes/newsletter.routes"));
app.use("/api/contact", require("./routes/contact.routes"));

app.get("/", (req, res) => res.send("Cotniva web worked successfully"));

app.use(globalErrorHandler);
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: "Not Found",
    errorMessages: [{ path: req.originalUrl, message: "API Not Found" }],
  });
  next();
});

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`server running on port ${PORT}`);
      startHoldExpiryJob();
      // After Mongo is ready — restore Baileys session from DB (one environment only)
      if (isAutoStartEnabled()) {
        startWhatsApp().catch((err) =>
          console.log("WhatsApp auto-start:", err.message)
        );
      } else {
        console.log(
          "WhatsApp auto-start disabled (WHATSAPP_AUTO_START=false). Use admin to connect if needed."
        );
      }
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

module.exports = app;
