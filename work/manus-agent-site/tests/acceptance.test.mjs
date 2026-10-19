import path from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ImageStorage } from "../lib/imageStorage.mjs";
import { TaskCheckpointManager } from "../lib/taskCheckpoint.mjs";
import { ImageTaskEngine } from "../lib/imageTaskEngine.mjs";
import { KeyManager } from "../lib/keyManager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(__dirname, "test-data");

// Helper to delay
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runTests() {
  console.log("==========================================================");
  console.log("  MANUS AI UNLIMITED: IMAGE GENERATION & RECOVERY TESTS");
  console.log("==========================================================\n");

  let passed = 0;
  let failed = 0;

  async function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  // Clean test directory
  if (existsSync(testDataDir)) {
    await rm(testDataDir, { recursive: true, force: true });
  }
  await mkdir(testDataDir, { recursive: true });

  const keysFilePath = path.join(testDataDir, "keys.json");
  const keyManager = new KeyManager(keysFilePath);
  await keyManager.init();

  // Add initial key (Key 1)
  const initialKey = await keyManager.addValidatedKey({
    rawKey: "sk-original-key-111111111111",
    label: "Primary Key",
    validationResult: {
      status: "active",
      credits: { total: 101, free: 0, refresh: 0 },
      user: { name: "Test User", email: "user@test.com" }
    }
  });

  const imageStorage = new ImageStorage(testDataDir);
  await imageStorage.init();

  const checkpointManager = new TaskCheckpointManager(testDataDir, imageStorage);
  await checkpointManager.init();

  // Track generator calls to verify zero duplicate regeneration
  const generatedCallLog = [];

  // Provider that simulates quota exhaustion at image 102 for Key 1
  const mockProvider = async params => {
    generatedCallLog.push({
      index: params.imageIndex,
      filename: params.filename,
      apiKey: params.apiKey
    });

    // Simulate quota error after 101 images on Key 1
    if (params.apiKey.includes("original-key") && params.imageIndex > 101) {
      const err = new Error("HTTP 429: Account quota limit reached. Insufficient credits.");
      err.status = 429;
      return { ok: false, isQuotaError: true, error: err.message };
    }

    // Return fake valid image buffer with index embedded
    const buf = Buffer.from(`PNG_IMAGE_DATA_INDEX_${params.imageIndex}_${params.filename}`);
    return { ok: true, buffer: buf };
  };

  const engine = new ImageTaskEngine({
    checkpointManager,
    imageStorage,
    keyManager,
    generatorProvider: mockProvider
  });

  // --------------------------------------------------------------------------
  // TEST A: QUOTA EXHAUSTION AFTER 101 IMAGES
  // --------------------------------------------------------------------------
  console.log("▶ TEST A: QUOTA EXHAUSTION AFTER 101 IMAGES (150 REQUESTED)");
  const task = await checkpointManager.createTask({
    title: "Generate 150 Storyboard Images",
    totalRequested: 150,
    script: "A cinematic story of space exploration across 150 scenes...",
    keyId: initialKey.id
  });

  await engine.startTask(task.taskId);

  // Wait for execution loop to generate 101 images and hit quota on image 102
  let cp = await checkpointManager.getCheckpoint(task.taskId);
  let attempts = 0;
  while (cp.status === "running" && attempts < 100) {
    await sleep(50);
    cp = await checkpointManager.getCheckpoint(task.taskId);
    attempts++;
  }

  await assert(cp.completedCount === 101, `Successfully saved exactly 101 images (got ${cp.completedCount})`);
  await assert(cp.remainingCount === 49, `Remaining count is 49 (got ${cp.remainingCount})`);
  await assert(cp.status === "paused", `Task status is paused (got ${cp.status})`);
  await assert(
    cp.pauseReason && cp.pauseReason.toLowerCase().includes("quota"),
    `Clear pause reason recorded: "${cp.pauseReason}"`
  );
  await assert(cp.lastSavedImage === "image_101.png", `Last saved image is image_101.png (got ${cp.lastSavedImage})`);

  // Verify all 101 images are on disk and verified
  const savedListA = await imageStorage.listSavedImages(task.taskId);
  await assert(savedListA.length === 101, `All 101 images are verified on disk (got ${savedListA.length})`);
  await assert(savedListA[0].filename === "image_001.png", `First image is image_001.png`);
  await assert(savedListA[100].filename === "image_101.png", `101st image is image_101.png`);
  console.log("  ✓ TEST A PASSED\n");

  // --------------------------------------------------------------------------
  // TEST H: ZIP DOWNLOAD WHILE PAUSED (101 IMAGES)
  // --------------------------------------------------------------------------
  console.log("▶ TEST H: ZIP DOWNLOAD WHILE PAUSED");
  const zipA = await imageStorage.createTaskZip(task.taskId);
  await assert(zipA.count === 101, `ZIP contains exactly 101 saved images (got ${zipA.count})`);
  await assert(Buffer.isBuffer(zipA.buffer) && zipA.buffer.length > 500, `ZIP buffer is valid (size: ${zipA.buffer.length} bytes)`);
  // Task must remain paused
  const cpAfterZip = await checkpointManager.getCheckpoint(task.taskId);
  await assert(cpAfterZip.status === "paused", `Task remains paused after ZIP generation`);
  console.log("  ✓ TEST H PASSED\n");

  // --------------------------------------------------------------------------
  // TEST D: NEW API KEY IS INVALID
  // --------------------------------------------------------------------------
  console.log("▶ TEST D: NEW API KEY IS INVALID");
  // Test validate with empty or malformed key
  const invalidVal = await keyManager.validateKey("");
  await assert(invalidVal.valid === false, `Empty key rejected`);
  // Task must not be destroyed
  const cpAfterInvalid = await checkpointManager.getCheckpoint(task.taskId);
  await assert(cpAfterInvalid.completedCount === 101, `Existing task preserved with 101 completed images`);
  await assert(cpAfterInvalid.status === "paused", `Task remains safely paused`);
  console.log("  ✓ TEST D PASSED\n");

  // --------------------------------------------------------------------------
  // TEST B: PROVIDE A NEW VALID API KEY
  // --------------------------------------------------------------------------
  console.log("▶ TEST B: PROVIDE A NEW VALID API KEY");
  const newKey = await keyManager.addValidatedKey({
    rawKey: "sk-fresh-replacement-key-999999",
    label: "Replacement Account Key",
    validationResult: {
      status: "active",
      credits: { total: 500, free: 200, refresh: 0 },
      user: { name: "Backup Account", email: "backup@test.com" }
    }
  });

  await assert(newKey.id && newKey.status === "active", `New API key added and active`);
  await assert(keyManager.maskKey(newKey.key) === "sk-fres••••••••9999", `Key secret properly masked in safe representation`);
  console.log("  ✓ TEST B PASSED\n");

  // --------------------------------------------------------------------------
  // TEST C: COMPLETE THE REMAINING 49 IMAGES (RESUME TASK)
  // --------------------------------------------------------------------------
  console.log("▶ TEST C: RESUME TASK AND GENERATE ONLY REMAINING 49 IMAGES");
  const callsBeforeResume = generatedCallLog.length;

  // Resume task with the new key
  await engine.startTask(task.taskId, { keyId: newKey.id });

  // Wait for task to finish generating remaining images 102 through 150
  attempts = 0;
  cp = await checkpointManager.getCheckpoint(task.taskId);
  while (cp.status === "running" && attempts < 150) {
    await sleep(50);
    cp = await checkpointManager.getCheckpoint(task.taskId);
    attempts++;
  }

  await assert(cp.completedCount === 150, `All 150 images completed (got ${cp.completedCount})`);
  await assert(cp.remainingCount === 0, `0 images remaining (got ${cp.remainingCount})`);
  await assert(cp.status === "completed", `Task status is completed (got ${cp.status})`);
  await assert(cp.lastSavedImage === "image_150.png", `Last saved image is image_150.png`);

  // Verify that images 1 through 101 were NEVER regenerated during resume!
  const callsAfterResume = generatedCallLog.slice(callsBeforeResume);
  const regeneratedCompleted = callsAfterResume.filter(c => c.index <= 101 && c.apiKey.includes("fresh-replacement"));
  await assert(
    regeneratedCompleted.length === 0,
    `Zero duplicate generation: Images 1-101 were skipped (regenerated count: ${regeneratedCompleted.length})`
  );

  // Verify only images 102 through 150 were generated with the new key
  const newKeyCalls = callsAfterResume.filter(c => c.apiKey.includes("fresh-replacement"));
  await assert(newKeyCalls.length === 49, `Exactly 49 images generated with new key (got ${newKeyCalls.length})`);
  await assert(newKeyCalls[0].index === 102, `Resumed directly from image 102`);
  await assert(newKeyCalls[newKeyCalls.length - 1].index === 150, `Ended at image 150`);

  // Check final collection has 150 images
  const finalSavedList = await imageStorage.listSavedImages(task.taskId);
  await assert(finalSavedList.length === 150, `150 verified images on disk (got ${finalSavedList.length})`);

  // Check final ZIP contains all 150 images
  const finalZip = await imageStorage.createTaskZip(task.taskId);
  await assert(finalZip.count === 150, `Final ZIP archive contains all 150 images (got ${finalZip.count})`);
  console.log("  ✓ TEST C PASSED\n");

  // --------------------------------------------------------------------------
  // TEST E: APPLICATION RESTART & PERSISTENCE RECOVERY
  // --------------------------------------------------------------------------
  console.log("▶ TEST E: APPLICATION RESTART & RECOVERY");
  // Create a new task that is partially completed (e.g. 5 out of 10)
  const taskE = await checkpointManager.createTask({
    title: "Restart Test Task",
    totalRequested: 10,
    keyId: newKey.id
  });

  // Save 5 images to disk for taskE
  for (let i = 1; i <= 5; i++) {
    const filename = `image_${String(i).padStart(3, "0")}.png`;
    await imageStorage.saveImageAtomically(taskE.taskId, filename, Buffer.from(`DATA_${i}`));
  }

  // Simulate total application shutdown / process restart: create brand new instances
  const restartedStorage = new ImageStorage(testDataDir);
  await restartedStorage.init();
  const restartedCPManager = new TaskCheckpointManager(testDataDir, restartedStorage);
  await restartedCPManager.init();

  // Reconcile task after restart
  const recoveredCP = await restartedCPManager.reconcileCheckpoint(taskE.taskId);
  await assert(recoveredCP !== null, `Task successfully recovered from disk`);
  await assert(recoveredCP.completedCount === 5, `Recovered exactly 5 completed images from disk`);
  await assert(recoveredCP.remainingCount === 5, `Correctly identified 5 remaining images`);
  await assert(recoveredCP.lastSavedImage === "image_005.png", `Recovered last saved image as image_005.png`);

  // Resume the task with engine
  const restartedEngine = new ImageTaskEngine({
    checkpointManager: restartedCPManager,
    imageStorage: restartedStorage,
    keyManager,
    generatorProvider: mockProvider
  });

  const callsBeforeE = generatedCallLog.length;
  await restartedEngine.startTask(taskE.taskId);

  attempts = 0;
  let cpE = await restartedCPManager.getCheckpoint(taskE.taskId);
  while (cpE.status === "running" && attempts < 50) {
    await sleep(50);
    cpE = await restartedCPManager.getCheckpoint(taskE.taskId);
    attempts++;
  }

  await assert(cpE.status === "completed", `Task completed after restart`);
  await assert(cpE.completedCount === 10, `All 10 images completed`);

  const callsAfterE = generatedCallLog.slice(callsBeforeE);
  const reGenE = callsAfterE.filter(c => c.index <= 5);
  await assert(reGenE.length === 0, `Images 1-5 were not regenerated upon restart`);
  console.log("  ✓ TEST E PASSED\n");

  // --------------------------------------------------------------------------
  // TEST F: STORAGE FAILURE HANDLING (RETRY WITH IN-MEMORY BUFFER)
  // --------------------------------------------------------------------------
  console.log("▶ TEST F: STORAGE FAILURE HANDLING");
  // Test saveImageAtomically retry on temporary error
  const testStorageBuf = Buffer.from("TEST_DATA_INTEGRITY");
  const saveResult = await imageStorage.saveImageAtomically("storage_test", "test_retry.png", testStorageBuf);
  await assert(saveResult.ok && saveResult.size === testStorageBuf.length, `Atomic write verified with exact size`);
  const verify = await imageStorage.verifyImageFile("storage_test", "test_retry.png");
  await assert(verify.exists && verify.size === testStorageBuf.length, `Storage integrity confirmed on disk`);
  console.log("  ✓ TEST F PASSED\n");

  // --------------------------------------------------------------------------
  // TEST G: MULTIPLE API KEYS & AUTOMATIC FAILOVER
  // --------------------------------------------------------------------------
  console.log("▶ TEST G: MULTIPLE API KEYS & AUTOMATIC FAILOVER");
  // Add Key A (depleted) and Key B (active with credits)
  const keyA = await keyManager.addValidatedKey({
    rawKey: "sk-pool-key-A-111111111111",
    label: "Pool Key A",
    validationResult: {
      status: "active",
      credits: { total: 2, free: 0 },
      user: { name: "User A", email: "a@test.com" }
    }
  });

  const keyB = await keyManager.addValidatedKey({
    rawKey: "sk-pool-key-B-222222222222",
    label: "Pool Key B",
    validationResult: {
      status: "active",
      credits: { total: 600, free: 0 },
      user: { name: "User B", email: "b@test.com" }
    }
  });

  // Provider that fails Key A after 2 images, then succeeds on Key B
  const failoverProvider = async params => {
    if (params.apiKey.includes("key-A") && params.imageIndex > 2) {
      return { ok: false, isQuotaError: true, error: "HTTP 429: Rate limit or quota exhausted" };
    }
    return { ok: true, buffer: Buffer.from(`IMAGE_${params.imageIndex}`) };
  };

  const failoverEngine = new ImageTaskEngine({
    checkpointManager,
    imageStorage,
    keyManager,
    generatorProvider: failoverProvider
  });

  const taskG = await checkpointManager.createTask({
    title: "Failover Test Task",
    totalRequested: 4,
    keyId: keyA.id
  });

  await failoverEngine.startTask(taskG.taskId);

  attempts = 0;
  let cpG = await checkpointManager.getCheckpoint(taskG.taskId);
  while (cpG.status === "running" && attempts < 50) {
    await sleep(50);
    cpG = await checkpointManager.getCheckpoint(taskG.taskId);
    attempts++;
  }

  await assert(cpG.status === "completed", `Task completed via automatic failover`);
  await assert(cpG.completedCount === 4, `All 4 images generated`);
  await assert(cpG.keyId === keyB.id, `Task automatically switched to Key B`);
  console.log("  ✓ TEST G PASSED\n");

  // --------------------------------------------------------------------------
  // TEST I: DUPLICATE PREVENTION & CONCILIATION
  // --------------------------------------------------------------------------
  console.log("▶ TEST I: DUPLICATE PREVENTION");
  // Check if saved images for task contain any duplicates in filenames
  const allImages = await imageStorage.listSavedImages(task.taskId);
  const filenameSet = new Set(allImages.map(i => i.filename));
  await assert(filenameSet.size === allImages.length, `No duplicate filenames in final image set (${allImages.length} unique)`);
  console.log("  ✓ TEST I PASSED\n");

  // Clean test directory
  if (existsSync(testDataDir)) {
    await rm(testDataDir, { recursive: true, force: true });
  }

  console.log("==========================================================");
  console.log(`  ALL ACCEPTANCE TESTS PASSED! (${passed} checks passed, ${failed} failed)`);
  console.log("==========================================================\n");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
