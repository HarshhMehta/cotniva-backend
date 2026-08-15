const { cloudinaryServices } = require("../services/cloudinary.service");

const MAX_REVIEW_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * Detect image type from magic bytes (do not trust client MIME alone).
 */
const detectImageMimeFromBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  // GIF (reject — not in allowed list, but detect for clearer errors)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }
  return null;
};

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const isAllowedCloudinaryUrl = (url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    return (
      u.hostname === "res.cloudinary.com" ||
      u.hostname.endsWith(".cloudinary.com")
    );
  } catch {
    return false;
  }
};

/**
 * Normalize optional image URLs from JSON body (already uploaded).
 */
const parseImageUrlList = (raw) => {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((u) => String(u || "").trim()).filter(Boolean);
};

/**
 * Validate + upload multer files to Cloudinary. Returns URL strings.
 */
const processReviewImageFiles = async (files = []) => {
  if (!files.length) return [];
  if (files.length > MAX_REVIEW_IMAGES) {
    const err = new Error(`You can upload at most ${MAX_REVIEW_IMAGES} images`);
    err.statusCode = 400;
    err.code = "TOO_MANY_IMAGES";
    throw err;
  }

  const urls = [];
  for (const file of files) {
    const buf = file.buffer;
    if (!buf || !Buffer.isBuffer(buf)) {
      const err = new Error("Invalid image upload");
      err.statusCode = 400;
      err.code = "INVALID_IMAGE";
      throw err;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      const err = new Error("Each image must be 4MB or smaller");
      err.statusCode = 400;
      err.code = "IMAGE_TOO_LARGE";
      throw err;
    }
    const detected = detectImageMimeFromBuffer(buf);
    if (!detected || !ALLOWED_IMAGE_MIMES.has(detected)) {
      const err = new Error(
        "Only JPEG, PNG, or WEBP images are allowed"
      );
      err.statusCode = 400;
      err.code = "INVALID_IMAGE_TYPE";
      throw err;
    }
    const result = await cloudinaryServices.cloudinaryImageUpload(buf);
    if (!result?.secure_url) {
      const err = new Error("Image upload failed");
      err.statusCode = 500;
      err.code = "UPLOAD_FAILED";
      throw err;
    }
    urls.push(result.secure_url);
  }
  return urls;
};

/**
 * Validate URL list from body (must be https Cloudinary URLs).
 */
const processReviewImageUrls = (raw) => {
  const list = parseImageUrlList(raw);
  if (list.length > MAX_REVIEW_IMAGES) {
    const err = new Error(`You can upload at most ${MAX_REVIEW_IMAGES} images`);
    err.statusCode = 400;
    err.code = "TOO_MANY_IMAGES";
    throw err;
  }
  for (const url of list) {
    if (!isAllowedCloudinaryUrl(url)) {
      const err = new Error("Invalid review image URL");
      err.statusCode = 400;
      err.code = "INVALID_IMAGE_URL";
      throw err;
    }
  }
  return list;
};

module.exports = {
  MAX_REVIEW_IMAGES,
  MAX_IMAGE_BYTES,
  detectImageMimeFromBuffer,
  ALLOWED_IMAGE_MIMES,
  isAllowedCloudinaryUrl,
  parseImageUrlList,
  processReviewImageFiles,
  processReviewImageUrls,
};
