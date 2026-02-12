import { createInterface } from "node:readline";
import { TunnelManager } from "./tunnel-manager.js";
import { loadConfig, saveConfig } from "./tunnel-config.js";

function createPrompt(): (question: string) => Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return (question: string) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
}

export async function runInteractiveSetup(): Promise<void> {
  const prompt = createPrompt();

  console.log("\n  Cloudflare Tunnel Setup\n");

  // Step 1: Check cloudflared
  console.log("  Checking for cloudflared...");
  const installed = await TunnelManager.checkCloudflaredInstalled();
  if (!installed) {
    console.log("\n  cloudflared is not installed.");
    console.log("  Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n");
    console.log("  On macOS:  brew install cloudflared");
    console.log("  On Linux:  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null");
    console.log("             sudo apt install cloudflared\n");
    process.exit(1);
  }
  console.log("  cloudflared found.\n");

  // Check if already configured
  const existing = loadConfig();
  if (existing) {
    const answer = await prompt(`  Tunnel "${existing.tunnelName}" (${existing.hostname}) already configured. Reconfigure? (y/N) `);
    if (answer.toLowerCase() !== "y") {
      console.log("  Setup cancelled.\n");
      process.exit(0);
    }
  }

  // Step 2: Login
  console.log("  Step 1: Authenticate with Cloudflare");
  console.log("  This will open your browser to log in to your Cloudflare account.\n");
  const loginResult = await TunnelManager.runLogin();
  if (!loginResult.success) {
    console.error(`\n  Login failed: ${loginResult.error}`);
    process.exit(1);
  }
  console.log("\n  Authenticated successfully.\n");

  // Step 3: Create tunnel
  const tunnelName = await prompt("  Step 2: Tunnel name (e.g. companion): ");
  if (!tunnelName) {
    console.log("  Tunnel name is required.");
    process.exit(1);
  }

  console.log(`  Creating tunnel "${tunnelName}"...`);
  const createResult = await TunnelManager.createTunnel(tunnelName);
  if ("error" in createResult) {
    console.error(`\n  Failed to create tunnel: ${createResult.error}`);
    process.exit(1);
  }
  console.log(`  Tunnel created: ${createResult.tunnelId}\n`);

  // Step 4: Route DNS
  const hostname = await prompt("  Step 3: Hostname (e.g. companion.example.com): ");
  if (!hostname) {
    console.log("  Hostname is required.");
    process.exit(1);
  }

  console.log(`  Routing DNS ${hostname} → tunnel...`);
  const routeResult = await TunnelManager.routeDns(tunnelName, hostname);
  if (!routeResult.success) {
    console.error(`\n  Failed to route DNS: ${routeResult.error}`);
    process.exit(1);
  }
  console.log("  DNS routed successfully.\n");

  // Step 5: Cloudflare Access team domain
  const teamDomain = await prompt("  Step 4: Cloudflare Access team domain (e.g. myorg — for myorg.cloudflareaccess.com, or leave empty to skip): ");
  const audienceTag = teamDomain
    ? await prompt("  Application Audience (AUD) tag (optional, press Enter to skip): ")
    : "";

  // Save config
  const now = Date.now();
  saveConfig({
    tunnelName,
    tunnelId: createResult.tunnelId,
    hostname,
    credentialsFile: createResult.credentialsFile,
    teamDomain: teamDomain || "",
    audienceTag: audienceTag || undefined,
    createdAt: now,
    updatedAt: now,
  });

  console.log("\n  Setup complete!\n");
  console.log(`  Tunnel:   ${tunnelName}`);
  console.log(`  Hostname: https://${hostname}`);
  if (teamDomain) {
    console.log(`  Access:   ${teamDomain}.cloudflareaccess.com`);
  }
  console.log(`\n  Start with: the-vibe-companion --tunnel`);
  console.log(`  Or toggle from the Companion UI.\n`);
}
