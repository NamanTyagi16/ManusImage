import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ImageStorage } from "../lib/imageStorage.mjs";
import { KeyManager } from "../lib/keyManager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(__dirname, "chat_test_temp");

console.log("\n==========================================================");
console.log("  CHAT IMAGE CONVERSATION & ROTATION WORKFLOW TESTS");
console.log("==========================================================\n");

async function run() {
  if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });

  const keysFile = path.join(testDir, "keys.json");
  const keyMgr = new KeyManager(keysFile);
  await keyMgr.init();

  keyMgr.keyPool.push({
    id: "key_1_primary",
    key: "sk-manus-key-1-primary",
    label: "Account 1",
    status: "active",
    credits: { total: 500, free: 100 }
  });
  keyMgr.keyPool.push({
    id: "key_2_backup",
    key: "sk-manus-key-2-backup",
    label: "Account 2",
    status: "active",
    credits: { total: 500, free: 100 }
  });
  await keyMgr.save();
  const key1 = keyMgr.keyPool[0];
  const key2 = keyMgr.keyPool[1];

  const storage = new ImageStorage(testDir);
  await storage.init();

  // Test 1: Key failover logic when Key 1 returns 429
  console.log("▶ TEST 1: Automatic Key Failover on Quota Exhaustion");
  let activeKey = keyMgr.getEligibleKey();
  assert.equal(activeKey.id, key1.id, "First key selected initially");

  // Simulate Key 1 quota exhaustion
  keyMgr.markKeyCooldown(key1.id, 60000, "Quota exhausted");
  const failoverKey = keyMgr.getEligibleKey();
  assert.equal(failoverKey.id, key2.id, "KeyManager seamlessly rotates to Key 2");
  console.log("  ✓ Seamless failover from Key 1 to Key 2 without prompting user");

  // Test 2: In-chat image persistence
  console.log("\n▶ TEST 2: In-Chat Image Auto-Persistence to Disk");
  const chatId = "chat_test_conv_99";
  const dummyImageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const saved = await storage.saveImageAtomically(chatId, "image_001.png", dummyImageBytes);

  assert.equal(saved.ok, true, "Image saved atomically");
  assert.equal(existsSync(saved.localPath), true, "File exists on disk");
  console.log("  ✓ Image image_001.png saved immediately to persistent disk");

  // Test 3: List saved images for the chat
  const list = await storage.listSavedImages(chatId);
  assert.equal(list.length, 1, "Exactly 1 saved image found for chat");
  console.log("  ✓ Verified persistent image count: 1 image");

  // Test 4: Download ZIP for the chat
  console.log("\n▶ TEST 3: In-Chat ZIP Download Generation");
  const zip = await storage.createTaskZip(chatId);
  assert.ok(zip.buffer.length > 0, "ZIP buffer generated");
  assert.equal(zip.count, 1, "ZIP contains 1 image");
  console.log(`  ✓ Generated ZIP archive of chat images (${zip.buffer.length} bytes)`);

  // Cleanup
  await rm(testDir, { recursive: true, force: true });
  console.log("\n==========================================================");
  console.log("  ALL CHAT IMAGE WORKFLOW TESTS PASSED!");
  console.log("==========================================================\n");
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
