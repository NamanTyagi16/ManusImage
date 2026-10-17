import http from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const envPath = path.join(__dirname, ".env");
const keysFilePath = path.join(dataDir, "keys.json");
const chatsFilePath = path.join(dataDir, "chats.json");

// Ensure data directory exists
if (!existsSync(dataDir)) {
  await mkdir(dataDir, { recursive: true });
}

// Load .env
if (existsSync(envPath)) {
  const env = readFileSync(envPath, "utf8");
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
}

const HOST = process.env.HOST || "0.0.0.0";
const parsedPort = Number(process.env.PORT || 5188);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 5188;
const MANUS_BASE_URL = "https://api.manus.ai/v2";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

// -------------------------------------------------------------
// Storage Management (Keys & Chats)
// -------------------------------------------------------------

async function loadJson(filePath, defaultValue) {
  try {
    if (!existsSync(filePath)) return defaultValue;
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content || "null") ?? defaultValue;
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return defaultValue;
  }
}

async function saveJson(filePath, data) {
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
  }
}

let keyPool = await loadJson(keysFilePath, []);
let chatList = await loadJson(chatsFilePath, []);

// Sync with .env / environment variables if needed
async function initializeKeys() {
  const envCandidates = [];

  // 1. Check MANUS_API_KEY
  if (process.env.MANUS_API_KEY) {
    envCandidates.push(process.env.MANUS_API_KEY.trim());
  }

  // 2. Check comma-separated MANUS_API_KEYS
  if (process.env.MANUS_API_KEYS) {
    for (const k of process.env.MANUS_API_KEYS.split(",")) {
      if (k.trim()) envCandidates.push(k.trim());
    }
  }

  // 3. Check numbered keys like MANUS_API_KEY_2, MANUS_API_KEY_3, etc.
  for (const [name, val] of Object.entries(process.env)) {
    if (/^MANUS_API_KEY_\d+$/i.test(name) || /^MANUS_KEY_\d+$/i.test(name)) {
      if (val && val.trim()) envCandidates.push(val.trim());
    }
  }

  const candidates = [...new Set(envCandidates)].filter(
    k => k && k !== "your_manus_api_key_here"
  );

  let modified = false;
  for (const rawKey of candidates) {
    const existing = keyPool.find(k => k.key === rawKey);
    if (!existing) {
      const newKeyObj = {
        id: "key_" + Math.random().toString(36).slice(2, 10),
        key: rawKey,
        label: `Key ${keyPool.length + 1} (.env)`,
        status: "active",
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        credits: null,
        user: null
      };
      keyPool.push(newKeyObj);
      modified = true;
    }
  }

  if (modified) {
    await saveJson(keysFilePath, keyPool);
  }

  // Refresh info in background for keys without info
  for (const k of keyPool) {
    if (!k.credits || !k.user) {
      refreshKeyInfo(k.id).catch(() => {});
    }
  }
}

await initializeKeys();

function maskKey(key) {
  if (!key || key.length < 10) return "••••••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

function getSafeKeys() {
  return keyPool.map(k => ({
    id: k.id,
    label: k.label,
    masked: maskKey(k.key),
    status: k.status,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    credits: k.credits,
    user: k.user
  }));
}

function getKeyById(keyId) {
  if (!keyId || keyId === "auto") {
    // Pick active key (round robin / least recently used)
    const activeKeys = keyPool.filter(k => k.status === "active");
    if (!activeKeys.length) return null;
    activeKeys.sort((a, b) => {
      const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return aTime - bTime;
    });
    return activeKeys[0];
  }
  return keyPool.find(k => k.id === keyId) || null;
}

async function refreshKeyInfo(keyId) {
  const entry = keyPool.find(k => k.id === keyId);
  if (!entry) return null;

  try {
    // 1. User info
    const userRes = await fetch(`${MANUS_BASE_URL}/user.me`, {
      headers: { "x-manus-api-key": entry.key }
    });
    if (!userRes.ok) {
      entry.status = userRes.status === 401 ? "invalid" : "error";
      await saveJson(keysFilePath, keyPool);
      return entry;
    }
    const userData = await userRes.json();
    entry.user = {
      name: userData.name || "",
      email: userData.email || ""
    };
    if (!entry.label || entry.label.startsWith("Key ")) {
      entry.label = userData.name || userData.email || entry.label;
    }

    // 2. Credits info
    const credRes = await fetch(`${MANUS_BASE_URL}/usage.availableCredits`, {
      headers: { "x-manus-api-key": entry.key }
    });
    if (credRes.ok) {
      const credData = await credRes.json();
      entry.credits = {
        total: credData.total_credits ?? 0,
        free: credData.free_credits ?? 0,
        refresh: credData.refresh_credits ?? 0,
        interval: credData.refresh_interval || "daily"
      };
      if (entry.credits.total <= 0 && entry.credits.free <= 0) {
        entry.status = "depleted";
      } else {
        entry.status = "active";
      }
    }

    await saveJson(keysFilePath, keyPool);
  } catch (err) {
    console.error(`Error refreshing key ${entry.id}:`, err.message);
  }
  return entry;
}

// -------------------------------------------------------------
// HTTP Utilities & Payloads
// -------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function readPayload(req) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      ...(await readJson(req)),
      files: []
    };
  }

  const request = new Request("http://127.0.0.1/upload", {
    method: "POST",
    headers: req.headers,
    body: req,
    duplex: "half"
  });
  const form = await request.formData();
  const files = [];
  for (const file of form.getAll("files")) {
    if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) continue;
    files.push(file);
  }

  return {
    prompt: String(form.get("prompt") || ""),
    taskId: String(form.get("taskId") || ""),
    chatId: String(form.get("chatId") || ""),
    keyId: String(form.get("keyId") || ""),
    files
  };
}

// -------------------------------------------------------------
// Manus API Wrapper
// -------------------------------------------------------------

async function manusFetch(endpoint, apiKey, options = {}) {
  const headers = {
    "x-manus-api-key": apiKey,
    ...(options.headers || {})
  };
  if (options.body && typeof options.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${MANUS_BASE_URL}${endpoint}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: { code: "invalid_json", message: text } };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data.error || { code: "http_error", message: response.statusText, detail: data },
      raw: data
    };
  }

  return data;
}

async function uploadFileToManus(file, apiKey) {
  const create = await manusFetch("/file.upload", apiKey, {
    method: "POST",
    body: JSON.stringify({ filename: file.name || "attachment" })
  });

  if (create.ok === false || !create.upload_url || !create.file?.id) {
    throw new Error(create.error?.message || "Unable to create Manus file upload");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const upload = await fetch(create.upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(bytes.length)
    },
    body: bytes
  });

  if (!upload.ok) {
    throw new Error(`Upload failed for ${file.name || "attachment"} (${upload.status})`);
  }

  const isAudio = String(file.type || "").toLowerCase().startsWith("audio/");
  return {
    type: isAudio ? "voice" : "file",
    file_id: create.file.id,
    filename: file.name || create.file.filename || "attachment",
    mime_type: file.type || "application/octet-stream",
    visibility: "visible"
  };
}

async function buildMessageContent(prompt, files = [], apiKey) {
  const content = [];
  const text = String(prompt || "").trim();
  if (text) content.push({ type: "text", text, visibility: "visible" });

  for (const file of files) {
    content.push(await uploadFileToManus(file, apiKey));
  }

  return content;
}

// -------------------------------------------------------------
// Message & Attachment Normalization
// -------------------------------------------------------------

function normalizeMessages(data) {
  const list = data.messages || data.items || data.data || [];
  if (!Array.isArray(list)) return [];
  return list.map((message, index) => {
    const content = formatMessageContent(message);
    const role =
      message.role ||
      message.sender ||
      message.author ||
      (message.type === "user_message" ? "user" : "assistant");
    const isUser = String(role).toLowerCase().includes("user");
    return {
      id: message.id || message.message_id || `message_${index}`,
      role,
      kind: message.status_update ? "status" : "message",
      content,
      attachments: isUser ? [] : extractAttachments(message, content),
      created_at: message.created_at || message.createdAt || ""
    };
  });
}

function formatMessageContent(message) {
  if (typeof message.content === "string") return message.content;
  if (message.content?.text) return message.content.text;
  if (message.message?.content) return message.message.content;
  if (message.user_message?.content) return message.user_message.content;
  if (message.assistant_message?.content) return message.assistant_message.content;
  if (message.status_update?.brief) {
    return message.status_update.description
      ? `${message.status_update.brief}: ${message.status_update.description}`
      : message.status_update.brief;
  }
  return JSON.stringify(message.content || message);
}

function extractAttachments(message, content) {
  const candidates = [];
  collectAttachmentCandidates(message, candidates);
  collectAttachmentCandidates(content, candidates);

  const seen = new Set();
  const attachments = candidates
    .map(normalizeAttachment)
    .filter(Boolean)
    .filter(attachment => {
      const key = attachment.url || attachment.path || attachment.label;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const accessibleNames = new Set(
    attachments
      .filter(attachment => attachment.accessible)
      .map(attachment => normalizeFileKey(attachment.label || attachment.url))
  );

  return attachments.filter(attachment => {
    const fileKey = normalizeFileKey(attachment.label || attachment.path || attachment.url);
    return attachment.accessible || !accessibleNames.has(fileKey);
  });
}

function collectAttachmentCandidates(value, candidates) {
  if (!value) return;

  if (typeof value === "string") {
    const markdownLinks = value.matchAll(/\[([^\]]+)\]\((?:<([^>]+)>|([^)]+))\)/g);
    for (const match of markdownLinks) {
      candidates.push({ label: match[1], ref: match[2] || match[3] });
    }

    const urls = value.matchAll(/https?:\/\/[^\s)]+/g);
    for (const match of urls) candidates.push({ ref: match[0] });

    const internalPaths = value.matchAll(/(?:\/home\/ubuntu|\/mnt\/data|\/tmp)\/[^\s)>\]]+/g);
    for (const match of internalPaths) candidates.push({ ref: match[0] });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentCandidates(item, candidates);
    return;
  }

  if (typeof value === "object") {
    const possibleKeys = [
      "url", "download_url", "downloadUrl", "file_url", "fileUrl", "path", "file_path", "filePath"
    ];
    if (possibleKeys.some(key => value[key])) {
      candidates.push({
        label: value.name || value.filename || value.title || value.label,
        ref: value.url || value.download_url || value.downloadUrl || value.file_url || value.fileUrl || value.path || value.file_path || value.filePath,
        mimeType: value.mime_type || value.mimeType || value.type
      });
    }

    for (const child of Object.values(value)) collectAttachmentCandidates(child, candidates);
  }
}

function normalizeAttachment(candidate) {
  const ref = String(candidate.ref || "").trim().replace(/[.,;:]+$/, "");
  if (!ref) return null;

  const isUrl = /^https?:\/\//i.test(ref);
  const name = candidate.label || ref.split(/[\\/]/).pop() || "Generated file";
  const extension = (name.match(/\.([a-z0-9]+)$/i)?.[1] || ref.match(/\.([a-z0-9]+)(?:\?|#|$)/i)?.[1] || "").toLowerCase();
  const image = ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension);
  const video = ["mp4", "webm", "mov"].includes(extension);
  const internal = !isUrl && ref.startsWith("/");

  return {
    label: name,
    url: isUrl ? ref : "",
    path: isUrl ? "" : ref,
    type: image ? "image" : video ? "video" : "file",
    mimeType: candidate.mimeType || "",
    accessible: isUrl,
    note: internal
      ? "Manus returned an internal file path. Ask Manus to export a downloadable link."
      : ""
  };
}

function normalizeFileKey(value) {
  return String(value || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[?#].*$/, "")
    .trim()
    .toLowerCase();
}

// -------------------------------------------------------------
// Public Share URL Helper
// -------------------------------------------------------------

async function ensurePublicShareUrl(taskId, apiKey) {
  if (!taskId || !apiKey) return null;

  try {
    // 1. Check current detail
    const detail = await manusFetch(`/task.detail?task_id=${encodeURIComponent(taskId)}`, apiKey);
    if (detail.ok && detail.task?.share_url) {
      return detail.task.share_url;
    }

    // 2. If not public, update share_visibility to "public"
    const updateRes = await manusFetch(`/task.update`, apiKey, {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        share_visibility: "public"
      })
    });

    if (updateRes.ok && updateRes.share_url) {
      return updateRes.share_url;
    }

    // 3. Fallback standard share link
    return `https://manus.im/share/${taskId}?replay=1`;
  } catch (err) {
    console.error(`Error ensuring public share URL for ${taskId}:`, err.message);
    return `https://manus.im/share/${taskId}?replay=1`;
  }
}

// -------------------------------------------------------------
// API Router
// -------------------------------------------------------------

async function handleApi(req, res, url) {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  try {
    // 1. System status
    if (url.pathname === "/api/status" && req.method === "GET") {
      const activeKeys = keyPool.filter(k => k.status === "active");
      const totalCredits = keyPool.reduce((acc, k) => acc + (k.credits?.total || 0), 0);
      return sendJson(res, 200, {
        ok: true,
        configured: keyPool.length > 0,
        activeKeysCount: activeKeys.length,
        totalKeysCount: keyPool.length,
        totalCredits,
        mode: keyPool.length > 0 ? "live" : "demo"
      });
    }

    // 2. Key Management Endpoints
    if (url.pathname === "/api/keys" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, keys: getSafeKeys() });
    }

    if (url.pathname === "/api/keys" && req.method === "POST") {
      const body = await readJson(req);
      const rawKey = String(body.key || "").trim();
      const label = String(body.label || "").trim();

      if (!rawKey) {
        return sendJson(res, 400, { ok: false, error: "API Key is required" });
      }

      // Check duplicate
      const duplicate = keyPool.find(k => k.key === rawKey);
      if (duplicate) {
        return sendJson(res, 400, { ok: false, error: "This API key has already been added." });
      }

      // Test with Manus API immediately
      const testUser = await manusFetch("/user.me", rawKey);
      if (testUser.ok === false) {
        return sendJson(res, 400, {
          ok: false,
          error: "Invalid Manus API key: Authentication failed.",
          detail: testUser.error
        });
      }

      // Fetch credits
      let credits = null;
      const testCred = await manusFetch("/usage.availableCredits", rawKey);
      if (testCred.ok) {
        credits = {
          total: testCred.total_credits ?? 0,
          free: testCred.free_credits ?? 0,
          refresh: testCred.refresh_credits ?? 0,
          interval: testCred.refresh_interval || "daily"
        };
      }

      const keyEntry = {
        id: "key_" + Math.random().toString(36).slice(2, 10),
        key: rawKey,
        label: label || testUser.name || testUser.email || `Key ${keyPool.length + 1}`,
        status: (credits && credits.total <= 0 && credits.free <= 0) ? "depleted" : "active",
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        credits,
        user: {
          name: testUser.name || "",
          email: testUser.email || ""
        }
      };

      keyPool.push(keyEntry);
      await saveJson(keysFilePath, keyPool);

      return sendJson(res, 201, {
        ok: true,
        message: "API key verified and added successfully",
        key: {
          id: keyEntry.id,
          label: keyEntry.label,
          masked: maskKey(keyEntry.key),
          status: keyEntry.status,
          credits: keyEntry.credits,
          user: keyEntry.user
        }
      });
    }

    if (url.pathname === "/api/keys" && req.method === "DELETE") {
      const keyId = url.searchParams.get("id");
      if (!keyId) return sendJson(res, 400, { ok: false, error: "Key ID required" });

      const idx = keyPool.findIndex(k => k.id === keyId);
      if (idx === -1) return sendJson(res, 404, { ok: false, error: "Key not found" });

      keyPool.splice(idx, 1);
      await saveJson(keysFilePath, keyPool);
      return sendJson(res, 200, { ok: true, message: "Key removed" });
    }

    if (url.pathname === "/api/keys/refresh" && req.method === "POST") {
      for (const k of keyPool) {
        await refreshKeyInfo(k.id);
      }
      return sendJson(res, 200, { ok: true, keys: getSafeKeys() });
    }

    // 3. Conversation & Chat Management Endpoints
    if (url.pathname === "/api/chats" && req.method === "GET") {
      // Sort newest first
      const sorted = [...chatList].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      return sendJson(res, 200, {
        ok: true,
        chats: sorted.map(c => ({
          id: c.id,
          taskId: c.taskId,
          title: c.title,
          status: c.status || "stopped",
          keyId: c.keyId,
          shareUrl: c.shareUrl,
          taskUrl: c.taskUrl,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messageCount: (c.messages || []).length
        }))
      });
    }

    if (url.pathname === "/api/chats" && req.method === "DELETE") {
      const chatId = url.searchParams.get("id");
      if (!chatId) return sendJson(res, 400, { ok: false, error: "Chat ID required" });

      const idx = chatList.findIndex(c => c.id === chatId);
      if (idx === -1) return sendJson(res, 404, { ok: false, error: "Chat not found" });

      const chat = chatList[idx];
      chatList.splice(idx, 1);
      await saveJson(chatsFilePath, chatList);

      // Attempt to stop/delete on Manus in background
      if (chat.taskId && chat.keyId) {
        const keyObj = keyPool.find(k => k.id === chat.keyId);
        if (keyObj) {
          manusFetch(`/task.delete`, keyObj.key, {
            method: "POST",
            body: JSON.stringify({ task_id: chat.taskId })
          }).catch(() => {});
        }
      }

      return sendJson(res, 200, { ok: true, message: "Chat deleted" });
    }

    // 4. Task Creation (New Chat in Background)
    if (url.pathname === "/api/task" && req.method === "POST") {
      const body = await readPayload(req);
      const content = String(body.prompt || "").trim();
      const files = body.files || [];
      const requestedKeyId = body.keyId || "";

      if (!content && !files.length) {
        return sendJson(res, 400, { ok: false, error: "Prompt or attachment is required" });
      }

      const activeKey = getKeyById(requestedKeyId);
      if (!activeKey) {
        return sendJson(res, 400, {
          ok: false,
          error: "No active Manus API key available. Please add an API key in the Keys Manager."
        });
      }

      // Mark key used time
      activeKey.lastUsedAt = new Date().toISOString();
      await saveJson(keysFilePath, keyPool);

      const messageContent = await buildMessageContent(content, files, activeKey.key);
      const createRes = await manusFetch("/task.create", activeKey.key, {
        method: "POST",
        body: JSON.stringify({
          message: { content: messageContent },
          title: content ? content.slice(0, 80) : "Attached files task",
          share_visibility: "public" // ALWAYS PUBLIC as requested!
        })
      });

      if (createRes.ok === false) {
        return sendJson(res, createRes.status || 502, createRes);
      }

      const taskId = createRes.task_id || createRes.task?.id || createRes.id;
      const taskUrl = createRes.task_url || `https://manus.im/app/${taskId}`;
      const shareUrl = createRes.share_url || `https://manus.im/share/${taskId}?replay=1`;

      const newChat = {
        id: "chat_" + Math.random().toString(36).slice(2, 10),
        taskId,
        title: createRes.task_title || content.slice(0, 60) || "New Manus Task",
        keyId: activeKey.id,
        keyLabel: activeKey.label,
        status: "running",
        shareUrl,
        taskUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: `msg_u_${Date.now()}`,
            role: "user",
            kind: "message",
            content,
            attachments: files.map(f => ({ label: f.name || "Attachment", type: "file" })),
            created_at: new Date().toISOString()
          }
        ]
      };

      chatList.unshift(newChat);
      await saveJson(chatsFilePath, chatList);

      return sendJson(res, 200, {
        ok: true,
        chat: newChat,
        task_id: taskId,
        task_url: taskUrl,
        share_url: shareUrl
      });
    }

    // 5. Send Message (Continue in Current Chat)
    if (url.pathname === "/api/message" && req.method === "POST") {
      const body = await readPayload(req);
      const chatId = String(body.chatId || "").trim();
      let taskId = String(body.taskId || "").trim();
      const content = String(body.prompt || "").trim();
      const files = body.files || [];

      let chat = chatList.find(c => c.id === chatId || c.taskId === taskId);
      if (!chat && taskId) {
        // Fallback: look up by taskId
        chat = chatList.find(c => c.taskId === taskId);
      }

      if (!taskId && chat) {
        taskId = chat.taskId;
      }

      if (!taskId || (!content && !files.length)) {
        return sendJson(res, 400, { ok: false, error: "taskId and prompt/attachment are required" });
      }

      const keyId = chat ? chat.keyId : (body.keyId || "");
      const keyObj = getKeyById(keyId);
      if (!keyObj) {
        return sendJson(res, 400, { ok: false, error: "No API key associated with this task" });
      }

      keyObj.lastUsedAt = new Date().toISOString();
      await saveJson(keysFilePath, keyPool);

      const messageContent = await buildMessageContent(content, files, keyObj.key);
      const sendRes = await manusFetch("/task.sendMessage", keyObj.key, {
        method: "POST",
        body: JSON.stringify({
          task_id: taskId,
          message: { content: messageContent }
        })
      });

      if (sendRes.ok === false) {
        return sendJson(res, sendRes.status || 502, sendRes);
      }

      if (chat) {
        chat.status = "running";
        chat.updatedAt = new Date().toISOString();
        chat.messages = chat.messages || [];
        chat.messages.push({
          id: `msg_u_${Date.now()}`,
          role: "user",
          kind: "message",
          content,
          attachments: files.map(f => ({ label: f.name || "Attachment", type: "file" })),
          created_at: new Date().toISOString()
        });
        await saveJson(chatsFilePath, chatList);
      }

      return sendJson(res, 200, { ok: true, taskId, chat });
    }

    // 6. Polling & List Messages for a Chat/Task
    if (url.pathname === "/api/messages" && req.method === "GET") {
      const chatId = String(url.searchParams.get("chatId") || "").trim();
      let taskId = String(url.searchParams.get("taskId") || "").trim();

      let chat = chatList.find(c => c.id === chatId || c.taskId === taskId);
      if (chat && !taskId) taskId = chat.taskId;

      if (!taskId) {
        return sendJson(res, 400, { ok: false, error: "taskId or chatId is required" });
      }

      const keyId = chat ? chat.keyId : url.searchParams.get("keyId");
      const keyObj = getKeyById(keyId);
      if (!keyObj) {
        return sendJson(res, 400, { ok: false, error: "API key not found for this task" });
      }

      // Fetch task messages
      const msgsData = await manusFetch(
        `/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=asc&limit=50`,
        keyObj.key,
        { method: "GET" }
      );

      // Fetch task detail for status and public share url
      let taskDetail = null;
      try {
        taskDetail = await manusFetch(
          `/task.detail?task_id=${encodeURIComponent(taskId)}`,
          keyObj.key,
          { method: "GET" }
        );
      } catch (e) {
        console.warn("Detail fetch warning:", e.message);
      }

      let taskStatus = taskDetail?.task?.status || chat?.status || "running";
      let shareUrl = taskDetail?.task?.share_url || chat?.shareUrl || "";
      let taskUrl = taskDetail?.task?.task_url || chat?.taskUrl || `https://manus.im/app/${taskId}`;

      // CRITICAL REQUIREMENT: If task has finished ("stopped") or waiting, ensure public share URL is generated!
      if (taskStatus === "stopped" || taskStatus === "waiting") {
        if (!shareUrl || shareUrl.includes("share_visibility=private")) {
          shareUrl = await ensurePublicShareUrl(taskId, keyObj.key);
        }
      }

      const normalized = msgsData.ok ? normalizeMessages(msgsData) : (chat?.messages || []);

      // Update chat in storage
      if (chat) {
        chat.status = taskStatus;
        if (shareUrl) chat.shareUrl = shareUrl;
        if (taskUrl) chat.taskUrl = taskUrl;
        if (taskDetail?.task?.title) chat.title = taskDetail.task.title;
        chat.messages = normalized;
        chat.updatedAt = new Date().toISOString();
        await saveJson(chatsFilePath, chatList);
      }

      return sendJson(res, 200, {
        ok: true,
        taskId,
        chatId: chat?.id,
        status: taskStatus,
        taskUrl,
        shareUrl,
        creditUsage: taskDetail?.task?.credit_usage || null,
        messages: normalized
      });
    }

    // 7. Sync Recent Tasks from Manus into Chats
    if (url.pathname === "/api/chats/sync" && req.method === "POST") {
      let importedCount = 0;
      for (const key of keyPool.filter(k => k.status === "active")) {
        try {
          const listRes = await manusFetch("/task.list?limit=15", key.key);
          if (listRes.ok && Array.isArray(listRes.data)) {
            for (const item of listRes.data) {
              const exists = chatList.find(c => c.taskId === item.id);
              if (!exists) {
                // Ensure public share URL
                let shareUrl = item.share_url;
                if (!shareUrl && item.status === "stopped") {
                  shareUrl = await ensurePublicShareUrl(item.id, key.key);
                }
                chatList.push({
                  id: "chat_" + Math.random().toString(36).slice(2, 10),
                  taskId: item.id,
                  title: item.title || "Manus Task",
                  keyId: key.id,
                  keyLabel: key.label,
                  status: item.status || "stopped",
                  shareUrl: shareUrl || `https://manus.im/share/${item.id}?replay=1`,
                  taskUrl: item.task_url || `https://manus.im/app/${item.id}`,
                  createdAt: new Date(Number(item.created_at) * 1000).toISOString(),
                  updatedAt: new Date(Number(item.updated_at) * 1000).toISOString(),
                  messages: []
                });
                importedCount++;
              }
            }
          }
        } catch (err) {
          console.error(`Sync error on key ${key.id}:`, err.message);
        }
      }
      if (importedCount > 0) {
        await saveJson(chatsFilePath, chatList);
      }
      return sendJson(res, 200, { ok: true, imported: importedCount });
    }

    return sendJson(res, 404, { ok: false, error: "API Endpoint not found" });
  } catch (error) {
    console.error("API Error:", error);
    return sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
}

// -------------------------------------------------------------
// Static File Server
// -------------------------------------------------------------

async function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname);
  if (requested === "/") requested = "/index.html";

  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = await readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}

// -------------------------------------------------------------
// Server Start
// -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

server.on("error", error => {
  console.error(`Server failed to start: ${error.code || error.name}`);
  console.error(error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`  Manus AI Unlimited Console running at:`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  Keys registered: ${keyPool.length}`);
  console.log(`======================================================\n`);
});
