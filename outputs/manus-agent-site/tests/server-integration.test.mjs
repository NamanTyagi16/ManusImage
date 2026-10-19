import http from "node:http";
import path from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runServerIntegrationTest() {
  console.log("==========================================================");
  console.log("  SERVER HTTP ENDPOINTS INTEGRATION TEST");
  console.log("==========================================================\n");

  const testPort = 5299;
  process.env.PORT = String(testPort);
  process.env.HOST = "127.0.0.1";

  // Import server modules
  const { imageStorage, checkpointManager, keyManager, imageTaskEngine } = await import("../server.mjs");

  const baseUrl = `http://127.0.0.1:${testPort}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let passed = 0;
  async function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  // 1. Test /api/status
  const statusRes = await fetch(`${baseUrl}/api/status`);
  const statusData = await statusRes.json();
  await assert(statusRes.status === 200 && statusData.ok === true, "GET /api/status returned 200 OK");

  // 2. Test /api/keys/validate with empty key
  const valBadRes = await fetch(`${baseUrl}/api/keys/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "" })
  });
  const valBadData = await valBadRes.json();
  await assert(valBadRes.status === 400 && valBadData.valid === false, "POST /api/keys/validate rejects empty key");

  // Add a test active key directly into keyManager
  const mockKey = await keyManager.addValidatedKey({
    rawKey: "sk-integration-test-key-123456",
    label: "Integration Key",
    validationResult: {
      status: "active",
      credits: { total: 100, free: 50 },
      user: { name: "Integration User", email: "integ@test.com" }
    }
  });
  await assert(mockKey.id && mockKey.status === "active", "Test key registered in KeyManager");

  // Provide mock generator to imageTaskEngine for realistic fast generation with small sleep
  imageTaskEngine.setGeneratorProvider(async params => {
    await sleep(40);
    return {
      ok: true,
      buffer: Buffer.from(`TEST_IMAGE_CONTENT_${params.imageIndex}_${params.filename}`)
    };
  });

  // 3. Test POST /api/image-tasks (Create Task)
  const createRes = await fetch(`${baseUrl}/api/image-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Integration Test 10 Images",
      totalRequested: 10,
      script: "Generate 10 scenes of cybernetic gardens...",
      keyId: mockKey.id
    })
  });
  const createData = await createRes.json();
  await assert(createRes.status === 201 && createData.ok === true, "POST /api/image-tasks created task");
  const taskId = createData.taskId;
  await assert(Boolean(taskId), `Task ID generated: ${taskId}`);

  // 4. Test GET /api/image-tasks (List Tasks)
  const listRes = await fetch(`${baseUrl}/api/image-tasks`);
  const listData = await listRes.json();
  await assert(listRes.status === 200 && Array.isArray(listData.tasks), "GET /api/image-tasks returns array");
  await assert(listData.tasks.some(t => t.taskId === taskId), "New task present in task list");

  // Wait for 3 images to be saved
  let taskDetail = null;
  let attempts = 0;
  while (attempts < 50) {
    await sleep(60);
    const detailRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}`);
    taskDetail = (await detailRes.json()).task;
    if (taskDetail.completedCount >= 3) break;
    attempts++;
  }
  await assert(taskDetail.completedCount >= 3, `Images incrementally saved: ${taskDetail.completedCount} saved`);

  // 5. Test POST /api/image-tasks/:taskId/pause
  const pauseRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}/pause`, { method: "POST" });
  const pauseData = await pauseRes.json();
  await assert(pauseRes.status === 200 && pauseData.ok === true, "POST /api/image-tasks/:id/pause paused task");

  // Verify task status is paused
  const pausedRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}`);
  const pausedData = (await pausedRes.json()).task;
  await assert(pausedData.status === "paused", "Task confirmed paused");

  // 6. Test GET /api/images/:taskId/image_001.png
  const imgRes = await fetch(`${baseUrl}/api/images/${taskId}/image_001.png`);
  await assert(imgRes.status === 200, "GET /api/images/:taskId/image_001.png served image file");
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  await assert(imgBytes.length > 0, `Image content verified (${imgBytes.length} bytes)`);

  // 7. Test GET /api/image-tasks/:taskId/download-zip WHILE PAUSED
  const zipRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}/download-zip`);
  await assert(zipRes.status === 200, "GET /api/image-tasks/:taskId/download-zip returns 200 while paused");
  await assert(zipRes.headers.get("content-type") === "application/zip", "Content-Type is application/zip");
  const zipBytes = Buffer.from(await zipRes.arrayBuffer());
  await assert(zipBytes.length > 200, `ZIP archive download verified (${zipBytes.length} bytes)`);

  // 8. Test POST /api/image-tasks/:taskId/resume
  const resumeRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: mockKey.id })
  });
  const resumeData = await resumeRes.json();
  await assert(resumeRes.status === 200 && resumeData.ok === true, "POST /api/image-tasks/:id/resume resumed task");

  // Wait for task completion (10/10)
  attempts = 0;
  while (attempts < 50) {
    await sleep(60);
    const detailRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}`);
    taskDetail = (await detailRes.json()).task;
    if (taskDetail.status === "completed") break;
    attempts++;
  }
  await assert(taskDetail.status === "completed", "Task completed execution after resume");
  await assert(taskDetail.completedCount === 10, "All 10 images completed and verified");

  // Final ZIP download with all 10 images
  const finalZipRes = await fetch(`${baseUrl}/api/image-tasks/${taskId}/download-zip`);
  await assert(finalZipRes.status === 200, "Final ZIP download returned 200");

  console.log("\n==========================================================");
  console.log(`  ALL SERVER INTEGRATION TESTS PASSED! (${passed} checks)`);
  console.log("==========================================================\n");

  process.exit(0);
}

runServerIntegrationTest().catch(err => {
  console.error("Integration test error:", err);
  process.exit(1);
});
