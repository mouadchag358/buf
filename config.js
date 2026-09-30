const path = require("path");

require("dotenv").config({ quiet: true });

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  TIME_ZONE: process.env.TIME_ZONE || "Africa/Casablanca",
  MAX_IMAGE_BYTES: positiveInteger(process.env.MAX_IMAGE_BYTES, 10 * 1024 * 1024),
  BUFFER_API_URL: process.env.BUFFER_API_URL || "https://api.buffer.com",
  BUFFER_ORGANIZATION_ID: process.env.BUFFER_ORGANIZATION_ID || "",
  BUFFER_MAX_SCHEDULED: positiveInteger(process.env.BUFFER_MAX_SCHEDULED, 10),
  BUFFER_REQUEST_TIMEOUT_MS: positiveInteger(process.env.BUFFER_REQUEST_TIMEOUT_MS, 30_000),
  PUBLIC_MEDIA_REPOSITORY: process.env.PUBLIC_MEDIA_REPOSITORY || process.env.GITHUB_REPOSITORY || "",
  PUBLIC_MEDIA_REF: process.env.PUBLIC_MEDIA_REF || "main",
  POSTS_FILE: path.join(__dirname, "posts.json")
};
