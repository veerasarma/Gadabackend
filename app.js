// server/app.js
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const path = require("path");
const http = require("node:http");

require("dotenv").config();

const initRoute = require("./routes/init.route");
const authRoutes = require("./routes/authRoutes");
const mediaRoutes = require("./routes/media");
const postRoutes = require("./routes/posts");
const userRoutes = require("./routes/users");
const storyRoutes = require("./routes/stories");
const groupsRoutes = require("./routes/groups");
const friendRoutes = require("./routes/friends");
const shareRoutes = require("./routes/shares");
const savesRoutes = require("./routes/saves");
const memoriesRouter = require("./routes/memories");
const payments = require("./routes/payments");
const packagesRoutes = require("./routes/packages");
const notificationRoutes = require("./routes/notifications");
const settingsRoutes = require("./routes/settings");
const adminRoutes = require("./routes/admin");
const adminSettingsRoutes = require("./routes/adminSettings");
const adminProfileRoutes = require("./routes/adminProfile");
const adminPostsRoutes = require("./routes/adminPosts");
const adminRepresentativesRoutes = require("./routes/adminRepresentatives");
const adminCommentsRoutes = require("./routes/adminComments");
const { initSystemConfig } = require("./config/systemLoader");
const initSystem = require("./middlewares/attachSystem");
const { initSocket } = require("./socket");
const pointsRoutes = require("./routes/points");
const representativesRoutes = require("./routes/representatives");
const proRoutes = require("./routes/pro");

const app = express();

// Make rate-limit & trust-proxy accurate if behind proxy
app.set("trust proxy", 1);

// ✅ Helmet configured to allow cross-origin <img>/<video> usage
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // critical for <img> from other origin (or canvas)
    crossOriginEmbedderPolicy: false, // don't block cross-origin media embedding
  })
);

// CORS (dev)
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(cookieParser());

// ⚠️ REMOVE any duplicate /uploads mounts; keep only this ONE
const uploadsDir = path.join(__dirname, "uploads"); // adjust if your folder is elsewhere
// app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(
  "/uploads",
  (req, _res, next) => {
    // console.log('[UPLOAD HIT]', req.method, req.url); // e.g. /profile/avatar.png
    next();
  },
  express.static(uploadsDir, {
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

app.use("/api/media", mediaRoutes);
// Body parsers (after static)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Rate limiter (after static so assets aren't rate-limited)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// System init
(async () => {
  try {
    await initSystemConfig();
    console.log("[SYSTEM] Config loaded");
  } catch (e) {
    console.error("[SYSTEM INIT FAILED]", e.message);
    process.exit(1);
  }
})();
app.use(initSystem);

// Routes
app.use("/api/posts", postRoutes);
app.use("/api/users", userRoutes);
app.use("/api/groups", groupsRoutes);
app.use("/api/stories", storyRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/shares", shareRoutes);
app.use("/api/saves", savesRoutes);
app.use("/api/memories", memoriesRouter);
app.use("/api/payments", payments);
app.use("/api/packages", packagesRoutes);
app.use("/api/reels", require("./routes/reels"));
app.use("/api/notifications", notificationRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/points", pointsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/settings", adminSettingsRoutes);
app.use("/api/admin/profile", adminProfileRoutes);
app.use("/api/admin/posts", adminPostsRoutes);
app.use("/api/admin/representatives", adminRepresentativesRoutes);
app.use("/api/admin/comments", adminCommentsRoutes);
app.use("/api/representatives", representativesRoutes);
app.use("/api/pro", proRoutes);
app.use("/api", initRoute);
app.use("/api", authRoutes);

app.get("/", (_req, res) => res.send("API is running"));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res
    .status(err.statusCode || 500)
    .json({ success: false, message: err.message || "Something went wrong" });
});
// console.log(process.env.CLIENT_ORIGIN,'process.env.CLIENT_ORIGINprocess.env.CLIENT_ORIGINprocess.env.CLIENT_ORIGIN')
// Socket
const server = http.createServer(app);
initSocket(server);

server.listen(process.env.PORT || 8085, () =>
  console.log(`Server running on port ${process.env.PORT || 8085}`)
);
