import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Task Checkpoint Manager
 * Manages persistent state, sequence numbering, and disk reconciliation.
 */
export class TaskCheckpointManager {
  constructor(baseDataDir, imageStorage) {
    this.baseDataDir = baseDataDir;
    this.imageStorage = imageStorage;
    this.tasksDir = path.join(baseDataDir, "tasks");
    this.registryFilePath = path.join(baseDataDir, "image_tasks.json");
    this.tasksCache = new Map();
  }

  async init() {
    if (!existsSync(this.tasksDir)) {
      await mkdir(this.tasksDir, { recursive: true });
    }
    await this.loadRegistry();
  }

  getTaskDir(taskId) {
    return path.join(this.tasksDir, taskId);
  }

  getCheckpointPath(taskId) {
    return path.join(this.getTaskDir(taskId), "checkpoint.json");
  }

  async loadRegistry() {
    try {
      if (existsSync(this.registryFilePath)) {
        const content = await readFile(this.registryFilePath, "utf8");
        const list = JSON.parse(content || "[]");
        for (const item of list) {
          if (item?.taskId) {
            // Load full checkpoint if exists
            const cp = await this.loadCheckpointFile(item.taskId);
            if (cp) {
              this.tasksCache.set(item.taskId, cp);
            } else {
              this.tasksCache.set(item.taskId, item);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error loading task registry:", err.message);
    }
  }

  async saveRegistry() {
    try {
      const summaryList = Array.from(this.tasksCache.values()).map(t => ({
        taskId: t.taskId,
        chatId: t.chatId || null,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        status: t.status,
        pauseReason: t.pauseReason || null,
        totalRequested: t.totalRequested,
        completedCount: t.completedCount,
        remainingCount: t.remainingCount,
        currentlyGenerating: t.currentlyGenerating || 0,
        failedCount: t.failedCount || 0,
        lastSavedImage: t.lastSavedImage || null,
        keyId: t.keyId || null
      }));
      // Sort newest first
      summaryList.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      await writeFile(this.registryFilePath, JSON.stringify(summaryList, null, 2), "utf8");
    } catch (err) {
      console.error("Error saving task registry:", err.message);
    }
  }

  async loadCheckpointFile(taskId) {
    try {
      const filePath = this.getCheckpointPath(taskId);
      if (!existsSync(filePath)) return null;
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async saveCheckpointFile(checkpoint) {
    const taskDir = this.getTaskDir(checkpoint.taskId);
    if (!existsSync(taskDir)) {
      await mkdir(taskDir, { recursive: true });
    }
    const filePath = this.getCheckpointPath(checkpoint.taskId);
    const content = JSON.stringify(checkpoint, null, 2);
    await writeFile(filePath, content, "utf8");
  }

  /**
   * Creates a new image generation task and initializes checkpoint.
   */
  async createTask({
    taskId = null,
    chatId = null,
    title = "",
    totalRequested = 150,
    script = "",
    referenceImages = [],
    settings = {},
    keyId = null,
    provider = "manus",
    prompts = null
  }) {
    const id = taskId || `task_img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    // Pad filename numbering based on total requested (e.g. 001 for 150, 0001 for 1000)
    const padLength = Math.max(3, String(totalRequested).length);

    // Build image slot records
    const images = [];
    for (let i = 1; i <= totalRequested; i++) {
      const numStr = String(i).padStart(padLength, "0");
      const filename = `image_${numStr}.png`;
      const promptText = prompts?.[i - 1]?.prompt || prompts?.[i - 1] || `Image ${i} for script: ${script.slice(0, 80)}`;
      images.push({
        index: i,
        filename,
        prompt: promptText,
        status: "pending", // "pending" | "generating" | "saved" | "failed"
        savedAt: null,
        size: 0,
        localPath: null,
        url: `/api/images/${id}/${filename}`
      });
    }

    const checkpoint = {
      taskId: id,
      chatId,
      title: title || `Generate ${totalRequested} Images`,
      createdAt: now,
      updatedAt: now,
      taskType: "image_generation",
      provider,
      keyId,
      status: "running", // "running" | "paused" | "completed" | "failed"
      pauseReason: null,
      totalRequested,
      completedCount: 0,
      remainingCount: totalRequested,
      currentlyGenerating: 0,
      failedCount: 0,
      lastSavedImage: null,
      lastSavedIndex: 0,
      config: {
        script,
        referenceImages,
        settings
      },
      images,
      logs: [
        {
          timestamp: now,
          level: "info",
          message: `Task initialized: ${totalRequested} images requested.`
        }
      ]
    };

    this.tasksCache.set(id, checkpoint);
    await this.saveCheckpointFile(checkpoint);
    await this.saveRegistry();

    return checkpoint;
  }

  /**
   * Retrieves a task checkpoint.
   */
  async getCheckpoint(taskId) {
    if (this.tasksCache.has(taskId)) {
      return this.tasksCache.get(taskId);
    }
    const cp = await this.loadCheckpointFile(taskId);
    if (cp) {
      this.tasksCache.set(taskId, cp);
      return cp;
    }
    return null;
  }

  /**
   * Updates and immediately persists checkpoint data.
   */
  async updateCheckpoint(taskId, updates) {
    const cp = await this.getCheckpoint(taskId);
    if (!cp) throw new Error(`Task ${taskId} not found`);

    Object.assign(cp, updates, { updatedAt: new Date().toISOString() });
    this.tasksCache.set(taskId, cp);
    await this.saveCheckpointFile(cp);
    await this.saveRegistry();
    return cp;
  }

  /**
   * Appends an audit log entry to the task checkpoint.
   */
  async addLog(taskId, level, message) {
    const cp = await this.getCheckpoint(taskId);
    if (!cp) return;
    cp.logs = cp.logs || [];
    cp.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message
    });
    // Keep last 100 log entries
    if (cp.logs.length > 100) cp.logs.shift();
    await this.saveCheckpointFile(cp);
  }

  /**
   * Reconciles checkpoint with on-disk image files.
   * Crucial for surviving restarts, verifying saved images, and skipping completed work.
   */
  async reconcileCheckpoint(taskId) {
    const cp = await this.getCheckpoint(taskId);
    if (!cp) return null;

    const savedFiles = await this.imageStorage.listSavedImages(taskId);
    const savedMap = new Map(savedFiles.map(f => [f.filename, f]));

    let completed = 0;
    let lastSavedIdx = 0;
    let lastSavedName = null;

    for (const img of cp.images) {
      const onDisk = savedMap.get(img.filename);
      if (onDisk && onDisk.size > 0) {
        img.status = "saved";
        img.size = onDisk.size;
        img.localPath = this.imageStorage.getImagePath(taskId, img.filename);
        img.savedAt = img.savedAt || onDisk.mtime.toISOString();
        completed++;
        if (img.index > lastSavedIdx) {
          lastSavedIdx = img.index;
          lastSavedName = img.filename;
        }
      } else {
        // If it was generating or uncertain when interrupted, mark as pending
        if (img.status !== "failed") {
          img.status = "pending";
          img.size = 0;
          img.localPath = null;
        }
      }
    }

    cp.completedCount = completed;
    cp.remainingCount = Math.max(0, cp.totalRequested - completed);
    cp.currentlyGenerating = 0;
    cp.lastSavedIndex = lastSavedIdx;
    cp.lastSavedImage = lastSavedName;

    if (cp.remainingCount === 0 && cp.completedCount >= cp.totalRequested) {
      cp.status = "completed";
      cp.pauseReason = null;
    }

    await this.updateCheckpoint(taskId, cp);
    return cp;
  }

  /**
   * Lists all task checkpoints sorted by newest first.
   */
  listTasks() {
    const list = Array.from(this.tasksCache.values());
    list.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    return list;
  }
}
