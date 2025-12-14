const fs = require("fs");
const path = require("path");

const apiBase = process.env.API_BASE;

if (!apiBase) {
  console.error("Missing API_BASE env var. Set API_BASE to your Render backend URL (e.g. https://your-api.onrender.com).");
  process.exit(1);
}

const out = `window.API_BASE = "${apiBase.replace(/"/g, '\\"')}";\n`;
const outPath = path.join(__dirname, "..", "web", "config.js");
fs.writeFileSync(outPath, out);
console.log(`Generated web/config.js with API_BASE=${apiBase}`);
