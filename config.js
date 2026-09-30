const path = require("path");

require("dotenv").config({ quiet: true });

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  HOST: process.env.HOST || "127.0.0.1",
  PORT: positiveInteger(process.env.PORT, 3000),
  TIME_ZONE: process.env.TIME_ZONE || "Africa/Casablanca",
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || "0 9,13 * * *",
  GRAPH_API_VERSION: process.env.GRAPH_API_VERSION || "v26.0",
  MAX_IMAGE_BYTES: positiveInteger(process.env.MAX_IMAGE_BYTES, 10 * 1024 * 1024),
  BUFFER_API_URL: process.env.BUFFER_API_URL || "https://api.buffer.com",
  BUFFER_ORGANIZATION_ID: process.env.BUFFER_ORGANIZATION_ID || "",
  BUFFER_MAX_SCHEDULED: positiveInteger(process.env.BUFFER_MAX_SCHEDULED, 10),
  BUFFER_REQUEST_TIMEOUT_MS: positiveInteger(process.env.BUFFER_REQUEST_TIMEOUT_MS, 30_000),
  PUBLIC_MEDIA_REPOSITORY: process.env.PUBLIC_MEDIA_REPOSITORY || process.env.GITHUB_REPOSITORY || "",
  PUBLIC_MEDIA_REF: process.env.PUBLIC_MEDIA_REF || "main",
  POSTS_FILE: path.join(__dirname, "posts.json"),
  IMAGE_LIBRARY_FILE: path.join(__dirname, "image-library.json"),
  IMAGES_DIRECTORY: path.join(__dirname, "images")
};
