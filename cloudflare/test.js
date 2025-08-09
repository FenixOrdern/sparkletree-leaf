import crypto from "node:crypto";
import fetch from "node-fetch"; // Node 18+ has global fetch; if needed: npm i node-fetch

const BASE =
  process.env.BASE_URL || "https://ai-pages-worker.erik-c0c.workers.dev"; // or https://pages.sparkletree.io
console.log("BASE URL: ", BASE);
const SECRET_HEX = process.env.HMAC_SECRET; // set this env var to your hex secret
console.log("SECRET_HEX length: ", SECRET_HEX.length);
if (!SECRET_HEX) {
  console.error("Set HMAC_SECRET env var");
  process.exit(1);
}

const method = "POST";
const pathWithQuery = "/api/create";
const body = JSON.stringify({
  tenant: "alice",
  slug: "index",
  html: "<!doctype html><h1>Hello Alice</h1>",
  htmlTTL: 60,
});

function sha256hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function hmacHex(keyHex, data) {
  const key = Buffer.from(keyHex, "hex");
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

const ts = String(Date.now());
const canon = `${method}\n${pathWithQuery}\n${ts}\n${sha256hex(body)}`;
const signature = hmacHex(SECRET_HEX, canon);

const res = await fetch(`${BASE}${pathWithQuery}`, {
  method,
  headers: {
    "content-type": "application/json",
    "x-pages-timestamp": ts,
    "x-pages-signature": `v1=${signature}`,
  },
  body,
});
console.log("status:", res.status);
console.log(await res.text());
