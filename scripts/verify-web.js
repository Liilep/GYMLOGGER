const fs = require("fs");
const path = require("path");

const requiredFiles = ["index.html", "app.js"];
const webDir = path.resolve(__dirname, "..", "web");

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(webDir, file)));

if (missing.length > 0) {
  console.error(`Missing required web assets in ${webDir}: ${missing.join(", ")}`);
  process.exit(1);
}
