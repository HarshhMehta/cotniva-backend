require("dotenv").config();
const express = require("express");
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
const galleryRoutes = require("./routes/gallery.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");
const homeRoutes = require("./routes/home.routes");
const sizeGuideRoutes = require("./routes/sizeGuide.routes");
const notificationRoutes = require("./routes/notification.routes");
const customerRoutes = require("./routes/customer.routes");
const { startWhatsApp } = require("./services/whatsapp.service");

const storeOrigins = [
  secret.client_url,
  process.env.STORE_URL,
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (storeOrigins.some((o) => origin === o || origin.startsWith(String(o).replace(/\/$/, "")))) {
        return cb(null, true);
      }
      if (
        origin.includes("localhost:3001") ||
        origin.includes("127.0.0.1:3001") ||
        (secret.admin_url &&
          origin.startsWith(String(secret.admin_url).replace(/\/$/, "")))
      ) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

connectDB();

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
app.use("/api/gallery", galleryRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/size-guide", sizeGuideRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/customers", customerRoutes);

app.get("/", (req, res) => res.send("Apps worked successfully"));

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
  startWhatsApp().catch((err) =>
    console.log("WhatsApp auto-start:", err.message)
  );
});

app.use(globalErrorHandler);
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: "Not Found",
    errorMessages: [{ path: req.originalUrl, message: "API Not Found" }],
  });
  next();
});

module.exports = app;
