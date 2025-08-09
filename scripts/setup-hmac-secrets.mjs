#!/usr/bin/env node
/**
 * setup-hmac-secrets.mjs
 *
 * Generates strong base64 secrets and registers them as Cloudflare Worker secrets via wrangler.
 * - PAGES_HMAC_SECRET (required): Used by the Worker to verify signed publish/rollback requests
 * - ADMIN_BEARER_TOKEN (optional --admin): For admin endpoints on your control-plane (Next.js)
 *
 * Requirements:
 * - Node 18+
 * - Cloudflare wrangler installed and authenticated (`wrangler login`)
 * - The Worker already exists (i.e., you've deployed once or created it) so `wrangler secret put --name <worker>` can target it.
 *
 * Usage:
 *   node scripts/setup-hmac-secrets.mjs --name ai-pages-worker
 *   node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --admin
 *   node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --print  # just print secrets, do not set in CF
 *   node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --length 32
 *
 * Options:
 *   --name,   -n   Cloudflare Worker name (default: ai-pages-worker)
 *   --admin         Also generate & set ADMIN_BEARER_TOKEN
 *   --length  -l    Byte length for randomness (default: 32)
 *   --print         Print generated secrets only; do not set in Cloudflare
 *
 * Notes:
 * - Secrets are generated as base64 strings (no hex). The Worker treats env secrets as UTF-8 text.
 * - Use the exact same string in your client (MCP server or test script) to sign requests (no encoding/decoding step).
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// ----------------------------- CLI parsing -----------------------------
function parseArgs(argv) {
  const out = {
    name: "ai-pages-worker",
    admin: false,
    length: 32,
    printOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name" || a === "-n") {
      out.name = argv[++i];
    } else if (a === "--admin") {
      out.admin = true;
    } else if (a === "--length" || a === "-l") {
      out.length = Number(argv[++i]);
    } else if (a === "--print") {
      out.printOnly = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
setup-hmac-secrets.mjs

Usage:
  node scripts/setup-hmac-secrets.mjs --name ai-pages-worker
  node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --admin
  node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --print
  node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --length 32

Options:
  --name, -n   Cloudflare Worker name (default: ai-pages-worker)
  --admin      Also generate & set ADMIN_BEARER_TOKEN
  --length,-l  Random byte length (default: 32)
  --print      Print secrets only; do not set in Cloudflare

Example:
  wrangler login
  node scripts/setup-hmac-secrets.mjs --name ai-pages-worker --admin
  # Then use the printed PAGES_HMAC_SECRET in your MCP server (HMAC_SECRET).
`);
}

// ----------------------------- helpers -----------------------------
function color(c, s) {
  // basic ANSI colors
  const map = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    bold: "\x1b[1m",
  };
  return (map[c] || "") + s + map.reset;
}

function ensureWrangler() {
  const r = spawnSync("wrangler", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    console.error(color("red", "Error: wrangler CLI not found or not working."));
    console.error("Install via: npm i -g wrangler");
    process.exit(1);
  }
}

function generateBase64Secret(lenBytes = 32) {
  return randomBytes(lenBytes).toString("base64");
}

function putSecret(workerName, key, value) {
  // Use wrangler secret put <KEY> --name <worker> with stdin piping
  // This will fail if the Worker doesn't exist. Ensure you deployed/created it first.
  const r = spawnSync(
    "wrangler",
    ["secret", "put", key, "--name", workerName],
    { input: value + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  if (r.status !== 0) {
    console.error(color("red", `Failed to set secret ${key} for ${workerName}`));
    if (out) console.error(out);
    if (err) console.error(err);
    process.exit(r.status || 1);
  }
  console.log(color("green", `✓ Set ${key} on ${workerName}`));
}

// ----------------------------- main -----------------------------
(async function main() {
  const args = parseArgs(process.argv);

  console.log(color("cyan", `Worker: ${args.name}`));
  console.log(color("cyan", `Randomness bytes: ${args.length}`));
  if (args.printOnly) {
    console.log(color("yellow", "Print-only mode: will not call wrangler."));
  } else {
    ensureWrangler();
  }

  // Generate secrets (base64)
  const hmacSecret = generateBase64Secret(args.length);
  const adminToken = args.admin ? generateBase64Secret(args.length) : null;

  console.log(color("bold", "\nGenerated secrets (store these securely):"));
  console.log(`PAGES_HMAC_SECRET: ${color("yellow", hmacSecret)}`);
  if (args.admin) {
    console.log(`ADMIN_BEARER_TOKEN: ${color("yellow", adminToken)}`);
  }

  if (args.printOnly) {
    console.log(
      color(
        "cyan",
        "\nRun these commands manually when ready:\n" +
          `  wrangler secret put PAGES_HMAC_SECRET --name ${args.name}\n` +
          (args.admin ? `  wrangler secret put ADMIN_BEARER_TOKEN --name ${args.name}\n` : "")
      )
    );
    return;
  }

  // Set secrets via wrangler
  console.log("\nRegistering secrets with Cloudflare (wrangler)...");
  putSecret(args.name, "PAGES_HMAC_SECRET", hmacSecret);
  if (args.admin && adminToken) {
    putSecret(args.name, "ADMIN_BEARER_TOKEN", adminToken);
  }

  console.log(
    color(
      "green",
      "\nAll set! Redeploy your Worker so secrets are available to the latest version:\n" +
        `  cd into-the-deep/cloudflare && wrangler deploy\n`
    )
  );
  console.log(
    "Client configuration notes:\n" +
      "- Use the exact PAGES_HMAC_SECRET string in your MCP server to sign requests.\n" +
      "- Canonical string to sign: METHOD + \"\\n\" + PATH_WITH_QUERY + \"\\n\" + TIMESTAMP + \"\\n\" + SHA256_HEX(BODY)\n" +
      "- Send headers: x-pages-timestamp, x-pages-signature (v1=<hex>)\n"
  );
})().catch((err) => {
  console.error(color("red", "Unexpected error in setup-hmac-secrets.mjs"));
  console.error(err);
  process.exit(1);
});
