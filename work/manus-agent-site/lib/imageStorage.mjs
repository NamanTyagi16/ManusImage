import path from "node:path";
import { mkdir, writeFile, rename, stat, readFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createZipArchive } from "./zipUtil.mjs";

/**
 * Image Storage Manager
 * Handles atomic writes, disk persistence, verification, and ZIP creation.
 */
export class ImageStorage {
  constructor(baseDataDir) {
    this.baseDataDir = baseDataDir;
    this.imagesDir = path.join(baseDataDir, "images");
  }

  async init() {
    if (!existsSync(this.imagesDir)) {
      await mkdir(this.imagesDir, { recursive: true });
    }
  }

  getTaskImageDir(taskId) {
    return path.join(this.imagesDir, taskId);
  }

  getImagePath(taskId, filename) {
    return path.join(this.getTaskImageDir(taskId), filename);
  }

  /**
   * Saves an image buffer atomically using a .tmp file and rename.
   * Verifies file integrity after write.
   * Retries up to maxRetries times on write failures.
   */
  async saveImageAtomically(taskId, filename, buffer, maxRetries = 3) {
    const taskDir = this.getTaskImageDir(taskId);
    if (!existsSync(taskDir)) {
      await mkdir(taskDir, { recursive: true });
    }

    const finalPath = this.getImagePath(taskId, filename);
    const tmpPath = path.join(taskDir, `${filename}.${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`);

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Write to temporary file
        await writeFile(tmpPath, buffer);

        // Verify temporary file integrity
        const tmpStat = await stat(tmpPath);
        if (tmpStat.size !== buffer.length || tmpStat.size === 0) {
          throw new Error(`Integrity check failed on tmp file: expected ${buffer.length} bytes, got ${tmpStat.size}`);
        }

        // Atomic rename
        await rename(tmpPath, finalPath);

        // Verify final file
        const finalStat = await stat(finalPath);
        if (finalStat.size !== buffer.length || finalStat.size === 0) {
          throw new Error(`Integrity check failed on final file: size mismatch`);
        }

        return {
          ok: true,
          filename,
          localPath: finalPath,
          size: finalStat.size,
          savedAt: new Date().toISOString()
        };
      } catch (err) {
        lastError = err;
        try {
          if (existsSync(tmpPath)) await unlink(tmpPath);
        } catch {}

        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 50 * attempt));
        }
      }
    }

    throw new Error(`Failed to save image ${filename} after ${maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Verifies if an image exists on disk and is readable and non-empty.
   */
  async verifyImageFile(taskId, filename) {
    try {
      const filePath = this.getImagePath(taskId, filename);
      if (!existsSync(filePath)) return { exists: false, size: 0 };
      const info = await stat(filePath);
      return {
        exists: info.isFile() && info.size > 0,
        size: info.size,
        mtime: info.mtime
      };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  /**
   * Reads an image file buffer from disk.
   */
  async readImage(taskId, filename) {
    const filePath = this.getImagePath(taskId, filename);
    return await readFile(filePath);
  }

  /**
   * Lists all verified, non-empty image files for a task.
   */
  async listSavedImages(taskId) {
    const taskDir = this.getTaskImageDir(taskId);
    if (!existsSync(taskDir)) return [];

    const files = await readdir(taskDir);
    const verified = [];

    for (const f of files) {
      if (f.endsWith(".tmp")) continue;
      const verify = await this.verifyImageFile(taskId, f);
      if (verify.exists) {
        verified.push({
          filename: f,
          size: verify.size,
          mtime: verify.mtime
        });
      }
    }

    // Sort by filename naturally (image_001, image_002, ...)
    verified.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    return verified;
  }

  /**
   * Builds a ZIP archive of all successfully saved images for a task.
   */
  async createTaskZip(taskId, customFilename = null) {
    const saved = await this.listSavedImages(taskId);
    if (!saved.length) {
      throw new Error(`No saved images found for task ${taskId}`);
    }

    const zipFiles = [];
    for (const item of saved) {
      const buffer = await this.readImage(taskId, item.filename);
      zipFiles.push({
        name: item.filename,
        data: buffer
      });
    }

    const zipBuffer = createZipArchive(zipFiles);
    return {
      filename: customFilename || `${taskId}_images_${saved.length}.zip`,
      count: saved.length,
      buffer: zipBuffer
    };
  }
}
