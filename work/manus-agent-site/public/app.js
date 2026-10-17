// ============================================================
// Manus AI Unlimited • Frontend Application Engine
// ============================================================

(function () {
  "use strict";

  // State
  let chats = [];
  let activeChatId = null;
  let keys = [];
  let selectedFiles = [];
  let pollingInterval = null;
  let isSending = false;

  // DOM Elements
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const themeToggle = document.getElementById("themeToggle");
  const newChatButton = document.getElementById("newChatButton");
  const chatSearchInput = document.getElementById("chatSearchInput");
  const chatListEl = document.getElementById("chatList");
  const syncChatsBtn = document.getElementById("syncChatsBtn");

  const openKeysModalBtn = document.getElementById("openKeysModalBtn");
  const openKeysDrawerBtn = document.getElementById("openKeysDrawerBtn");
  const keysModalOverlay = document.getElementById("keysModalOverlay");
  const closeKeysModalBtn = document.getElementById("closeKeysModalBtn");
  const addKeyForm = document.getElementById("addKeyForm");
  const newApiKeyInput = document.getElementById("newApiKeyInput");
  const newKeyLabelInput = document.getElementById("newKeyLabelInput");
  const saveKeyBtn = document.getElementById("saveKeyBtn");
  const refreshKeysBtn = document.getElementById("refreshKeysBtn");
  const keyFormFeedback = document.getElementById("keyFormFeedback");
  const keysListContainer = document.getElementById("keysListContainer");
  const modalKeysCount = document.getElementById("modalKeysCount");
  const keysCountBadge = document.getElementById("keysCountBadge");
  const keySummaryTitle = document.getElementById("keySummaryTitle");
  const keySummaryCredits = document.getElementById("keySummaryCredits");

  const currentChatTitle = document.getElementById("currentChatTitle");
  const currentChatStatus = document.getElementById("currentChatStatus");
  const currentChatKey = document.getElementById("currentChatKey");
  const currentChatTaskId = document.getElementById("currentChatTaskId");
  const shareActionGroup = document.getElementById("shareActionGroup");
  const copyShareUrlBtn = document.getElementById("copyShareUrlBtn");
  const openShareUrlLink = document.getElementById("openShareUrlLink");

  const chatStreamContainer = document.getElementById("chatStreamContainer");
  const emptyHero = document.getElementById("emptyHero");
  const messagesFlow = document.getElementById("messagesFlow");

  const modeContinue = document.getElementById("modeContinue");
  const modeNew = document.getElementById("modeNew");
  const keySelector = document.getElementById("keySelector");
  const composerForm = document.getElementById("composerForm");
  const composerInput = document.getElementById("composerInput");
  const attachBtn = document.getElementById("attachBtn");
  const fileInput = document.getElementById("fileInput");
  const attachmentTray = document.getElementById("attachmentTray");
  const sendBtn = document.getElementById("sendBtn");
  const toastEl = document.getElementById("toast");

  // -------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------

  async function init() {
    setupEventListeners();
    await loadKeys();
    await loadChats();
    startBackgroundPolling();
  }

  function setupEventListeners() {
    // Theme toggle
    themeToggle.addEventListener("click", () => {
      const html = document.documentElement;
      const current = html.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", next);
      localStorage.setItem("manus_theme", next);
    });
    const savedTheme = localStorage.getItem("manus_theme");
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

    // Sidebar toggle for mobile
    sidebarToggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    // New Chat button
    newChatButton.addEventListener("click", () => {
      createNewChatSession();
    });

    // Keyboard shortcut Cmd/Ctrl + N
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createNewChatSession();
      }
    });

    // Chat search filter
    chatSearchInput.addEventListener("input", (e) => {
      renderChatList(e.target.value.trim().toLowerCase());
    });

    // Sync button
    syncChatsBtn.addEventListener("click", syncManusChats);

    // Modals
    openKeysModalBtn.addEventListener("click", openKeysModal);
    openKeysDrawerBtn.addEventListener("click", openKeysModal);
    closeKeysModalBtn.addEventListener("click", closeKeysModal);
    keysModalOverlay.addEventListener("click", (e) => {
      if (e.target === keysModalOverlay) closeKeysModal();
    });

    // Add Key Form
    addKeyForm.addEventListener("submit", handleAddKey);
    refreshKeysBtn.addEventListener("click", handleRefreshKeys);

    // Composer Input auto-resize & keyboard submit
    composerInput.addEventListener("input", () => {
      composerInput.style.height = "auto";
      composerInput.style.height = Math.min(composerInput.scrollHeight, 180) + "px";
    });

    composerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        composerForm.requestSubmit();
      }
    });

    // File attachments
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", handleFileSelection);

    // Prompt Card clicks in empty state
    document.querySelectorAll(".prompt-card").forEach(card => {
      card.addEventListener("click", () => {
        const text = card.getAttribute("data-prompt") || "";
        composerInput.value = text;
        composerInput.focus();
        composerInput.style.height = Math.min(composerInput.scrollHeight, 180) + "px";
      });
    });

    // Form Submit
    composerForm.addEventListener("submit", handleSendMessage);

    // Top Share URL actions
    copyShareUrlBtn.addEventListener("click", () => {
      const activeChat = getActiveChat();
      if (activeChat && activeChat.shareUrl) {
        navigator.clipboard.writeText(activeChat.shareUrl);
        showToast("Public chat link copied to clipboard!");
      }
    });
  }

  // -------------------------------------------------------------
  // API Keys Pool Management
  // -------------------------------------------------------------

  async function loadKeys() {
    try {
      const res = await fetch("/api/keys");
      const data = await res.json();
      if (data.ok) {
        keys = data.keys || [];
        updateKeysUI();
      }
    } catch (err) {
      console.error("Failed to load keys:", err);
    }
  }

  function updateKeysUI() {
    const activeKeys = keys.filter(k => k.status === "active");
    const totalCredits = keys.reduce((acc, k) => acc + (k.credits?.total || 0), 0);

    // Update Sidebar Key summary pill
    if (activeKeys.length > 0) {
      keySummaryTitle.textContent = `${activeKeys.length} Active Key${activeKeys.length > 1 ? "s" : ""}`;
      keySummaryCredits.textContent = `${totalCredits.toLocaleString()} credits available`;
    } else {
      keySummaryTitle.textContent = "No Keys Configured";
      keySummaryCredits.textContent = "Click to add a key";
    }

    keysCountBadge.textContent = keys.length;
    modalKeysCount.textContent = keys.length;

    // Update Key Selector in Composer
    keySelector.innerHTML = '<option value="auto">⚡ Auto Pool (Balanced)</option>';
    keys.forEach(k => {
      const opt = document.createElement("option");
      opt.value = k.id;
      const creditsStr = k.credits ? ` (${k.credits.total} cr)` : "";
      opt.textContent = `${k.label}${creditsStr}`;
      keySelector.appendChild(opt);
    });

    renderKeysList();
  }

  function renderKeysList() {
    keysListContainer.innerHTML = "";
    if (keys.length === 0) {
      keysListContainer.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:12px;text-align:center;">No API keys configured yet. Add one above!</div>';
      return;
    }

    keys.forEach(k => {
      const card = document.createElement("div");
      card.className = "key-card";

      const left = document.createElement("div");
      left.className = "key-card-left";
      left.innerHTML = `
        <div class="key-avatar">${(k.label || "K").slice(0, 2).toUpperCase()}</div>
        <div class="key-card-info">
          <strong>${escapeHtml(k.label)}</strong>
          <span class="key-user">${escapeHtml(k.user?.email || k.user?.name || "Verified Manus Key")}</span>
          <span class="key-masked">${escapeHtml(k.masked)}</span>
        </div>
      `;

      const right = document.createElement("div");
      right.className = "key-card-right";

      const credits = k.credits?.total ?? 0;
      const free = k.credits?.free ?? 0;
      right.innerHTML = `
        <div class="key-credits-pill">
          <strong>${credits.toLocaleString()} credits</strong>
          <small>Free: ${free} • Status: ${escapeHtml(k.status)}</small>
        </div>
        <button class="btn-delete-key" title="Delete key" type="button">🗑</button>
      `;

      right.querySelector(".btn-delete-key").addEventListener("click", () => handleDeleteKey(k.id));

      card.appendChild(left);
      card.appendChild(right);
      keysListContainer.appendChild(card);
    });
  }

  function openKeysModal() {
    keysModalOverlay.classList.add("open");
    keyFormFeedback.textContent = "";
  }

  function closeKeysModal() {
    keysModalOverlay.classList.remove("open");
  }

  async function handleAddKey(e) {
    e.preventDefault();
    const key = newApiKeyInput.value.trim();
    const label = newKeyLabelInput.value.trim();
    if (!key) return;

    saveKeyBtn.disabled = true;
    saveKeyBtn.innerHTML = "<span>Verifying...</span>";
    keyFormFeedback.className = "form-feedback";
    keyFormFeedback.textContent = "Connecting to Manus API...";

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, label })
      });
      const data = await res.json();
      if (data.ok) {
        keyFormFeedback.className = "form-feedback success";
        keyFormFeedback.textContent = "✓ Key verified and added successfully!";
        newApiKeyInput.value = "";
        newKeyLabelInput.value = "";
        await loadKeys();
        showToast("New API key added to pool!");
      } else {
        keyFormFeedback.className = "form-feedback error";
        keyFormFeedback.textContent = `Error: ${data.error || "Failed to verify key"}`;
      }
    } catch (err) {
      keyFormFeedback.className = "form-feedback error";
      keyFormFeedback.textContent = `Network error: ${err.message}`;
    } finally {
      saveKeyBtn.disabled = false;
      saveKeyBtn.innerHTML = "<span>Verify & Add Key</span>";
    }
  }

  async function handleDeleteKey(keyId) {
    if (!confirm("Are you sure you want to remove this API key from the pool?")) return;
    try {
      const res = await fetch(`/api/keys?id=${encodeURIComponent(keyId)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        await loadKeys();
        showToast("API key removed.");
      }
    } catch (err) {
      showToast("Error deleting key: " + err.message);
    }
  }

  async function handleRefreshKeys() {
    refreshKeysBtn.disabled = true;
    refreshKeysBtn.textContent = "Refreshing...";
    try {
      const res = await fetch("/api/keys/refresh", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        keys = data.keys || [];
        updateKeysUI();
        showToast("All key quotas updated.");
      }
    } catch (err) {
      showToast("Error refreshing keys.");
    } finally {
      refreshKeysBtn.disabled = false;
      refreshKeysBtn.textContent = "↻ Refresh All Quotas";
    }
  }

  // -------------------------------------------------------------
  // Conversation & Chat Session Management
  // -------------------------------------------------------------

  async function loadChats() {
    try {
      const res = await fetch("/api/chats");
      const data = await res.json();
      if (data.ok) {
        chats = data.chats || [];
        renderChatList();
        if (chats.length > 0 && !activeChatId) {
          selectChat(chats[0].id);
        } else if (!activeChatId) {
          createNewChatSession();
        }
      }
    } catch (err) {
      console.error("Failed to load chats:", err);
    }
  }

  function createNewChatSession() {
    activeChatId = null;
    currentChatTitle.textContent = "New Conversation";
    currentChatStatus.textContent = "Idle";
    currentChatStatus.className = "status-badge";
    currentChatKey.textContent = "Auto Pool";
    currentChatTaskId.textContent = "";
    shareActionGroup.style.display = "none";

    emptyHero.style.display = "flex";
    messagesFlow.style.display = "none";
    messagesFlow.innerHTML = "";

    // Switch routing mode to "new" automatically for fresh chats
    modeNew.checked = true;

    // Deselect sidebar items
    document.querySelectorAll(".chat-item").forEach(el => el.classList.remove("active"));
    composerInput.focus();
  }

  function selectChat(chatId) {
    activeChatId = chatId;
    const chat = getActiveChat();
    if (!chat) {
      createNewChatSession();
      return;
    }

    // Default to continuing this chat when an existing chat is clicked
    modeContinue.checked = true;

    // Update Header
    currentChatTitle.textContent = chat.title || "Manus Task";
    updateStatusBadge(chat.status);
    const boundKey = keys.find(k => k.id === chat.keyId);
    currentChatKey.textContent = boundKey ? boundKey.label : (chat.keyLabel || "Auto Pool");
    currentChatTaskId.textContent = chat.taskId ? `ID: ${chat.taskId.slice(0, 8)}...` : "";

    // Update Public Share Buttons in Header
    updateShareGroupUI(chat.shareUrl);

    // Switch Views
    emptyHero.style.display = "none";
    messagesFlow.style.display = "flex";

    // Highlight item in sidebar
    document.querySelectorAll(".chat-item").forEach(el => {
      el.classList.toggle("active", el.getAttribute("data-id") === chatId);
    });

    // Fetch latest messages & render
    pollChatMessages(chatId, true);
  }

  function getActiveChat() {
    return chats.find(c => c.id === activeChatId) || null;
  }

  function renderChatList(filter = "") {
    chatListEl.innerHTML = "";
    const filtered = filter ? chats.filter(c => (c.title || "").toLowerCase().includes(filter)) : chats;

    if (filtered.length === 0) {
      chatListEl.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:16px;text-align:center;">No conversations found</div>';
      return;
    }

    filtered.forEach(chat => {
      const item = document.createElement("div");
      item.className = `chat-item ${chat.id === activeChatId ? "active" : ""}`;
      item.setAttribute("data-id", chat.id);

      const statusClass = (chat.status || "stopped").toLowerCase();

      item.innerHTML = `
        <div class="chat-item-header">
          <span class="status-indicator ${statusClass}"></span>
          <span class="chat-item-title">${escapeHtml(chat.title || "New Task")}</span>
          <button class="item-delete-btn" title="Delete conversation" type="button">✕</button>
        </div>
        <div class="chat-item-meta">
          <span class="item-key-tag">${escapeHtml(chat.keyLabel || "Pool")}</span>
          ${chat.shareUrl ? `<span class="item-share-link" title="Copy public link">🔗 Share</span>` : ""}
          <span style="margin-left:auto">${formatTimeAgo(chat.updatedAt || chat.createdAt)}</span>
        </div>
      `;

      item.addEventListener("click", (e) => {
        if (e.target.closest(".item-delete-btn")) {
          e.stopPropagation();
          handleDeleteChat(chat.id);
          return;
        }
        if (e.target.closest(".item-share-link")) {
          e.stopPropagation();
          navigator.clipboard.writeText(chat.shareUrl);
          showToast("Public link copied to clipboard!");
          return;
        }
        selectChat(chat.id);
      });

      chatListEl.appendChild(item);
    });
  }

  async function handleDeleteChat(chatId) {
    if (!confirm("Are you sure you want to delete this chat session?")) return;
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        chats = chats.filter(c => c.id !== chatId);
        renderChatList();
        if (activeChatId === chatId) {
          if (chats.length > 0) selectChat(chats[0].id);
          else createNewChatSession();
        }
        showToast("Conversation deleted.");
      }
    } catch (err) {
      showToast("Error deleting chat: " + err.message);
    }
  }

  async function syncManusChats() {
    syncChatsBtn.textContent = "Syncing...";
    try {
      const res = await fetch("/api/chats/sync", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        showToast(`Synced ${data.imported} recent tasks from Manus.`);
        await loadChats();
      }
    } catch (err) {
      showToast("Failed to sync tasks.");
    } finally {
      syncChatsBtn.textContent = "↻ Sync";
    }
  }

  // -------------------------------------------------------------
  // Send Prompt (Single Chat vs New Background Chat)
  // -------------------------------------------------------------

  async function handleSendMessage(e) {
    e.preventDefault();
    const prompt = composerInput.value.trim();
    if (!prompt && selectedFiles.length === 0) return;
    if (isSending) return;

    const isNewChat = modeNew.checked || !activeChatId;
    const selectedKeyId = keySelector.value;

    isSending = true;
    sendBtn.disabled = true;
    sendBtn.innerHTML = "<span>Transmitting...</span>";

    const formData = new FormData();
    formData.append("prompt", prompt);
    selectedFiles.forEach(f => formData.append("files", f));

    // Clear composer input immediately
    composerInput.value = "";
    composerInput.style.height = "auto";
    const filesToClear = [...selectedFiles];
    clearSelectedFiles();

    try {
      if (isNewChat) {
        // Option 1: Spawn brand new background chat
        formData.append("keyId", selectedKeyId);
        showToast("🚀 Launching new background Manus task...");

        const res = await fetch("/api/task", {
          method: "POST",
          body: formData
        });
        const data = await res.json();

        if (data.ok && data.chat) {
          chats.unshift(data.chat);
          renderChatList();
          selectChat(data.chat.id);
          showToast("Task created in background!");
        } else {
          showToast(`Error: ${data.error || "Failed to create task"}`);
        }
      } else {
        // Option 2: Continue in current chat
        const currentChat = getActiveChat();
        formData.append("chatId", currentChat.id);
        formData.append("taskId", currentChat.taskId);

        // Append user message to UI right away
        appendUserMessageUI(prompt, filesToClear);
        updateStatusBadge("running");

        const res = await fetch("/api/message", {
          method: "POST",
          body: formData
        });
        const data = await res.json();

        if (data.ok) {
          showToast("Message sent to active chat.");
          pollChatMessages(currentChat.id, true);
        } else {
          showToast(`Error: ${data.error || "Failed to send message"}`);
        }
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`);
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<span class="send-label">Send</span><span class="send-icon">↑</span>';
      composerInput.focus();
    }
  }

  function appendUserMessageUI(text, files) {
    emptyHero.style.display = "none";
    messagesFlow.style.display = "flex";

    const row = document.createElement("div");
    row.className = "message-row user";
    row.innerHTML = `
      <div class="msg-avatar">Y</div>
      <div class="msg-body">
        <span class="msg-sender">You</span>
        <div class="msg-bubble">
          <p>${escapeHtml(text)}</p>
          ${files.map(f => `<div class="attachment-pill" style="margin-top:4px;">📎 ${escapeHtml(f.name)}</div>`).join("")}
        </div>
      </div>
    `;
    messagesFlow.appendChild(row);
    scrollToBottom();
  }

  // -------------------------------------------------------------
  // Polling Engine & Message Rendering
  // -------------------------------------------------------------

  function startBackgroundPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(async () => {
      // 1. Poll the active chat if running
      const activeChat = getActiveChat();
      if (activeChat && (activeChat.status === "running" || activeChat.status === "waiting")) {
        await pollChatMessages(activeChat.id, false);
      }

      // 2. Also poll other background running chats to keep sidebar status and share URLs fresh
      for (const chat of chats) {
        if (chat.id !== activeChatId && (chat.status === "running" || chat.status === "waiting")) {
          try {
            const res = await fetch(`/api/messages?chatId=${encodeURIComponent(chat.id)}`);
            const data = await res.json();
            if (data.ok) {
              chat.status = data.status;
              if (data.shareUrl) chat.shareUrl = data.shareUrl;
              renderChatList();
            }
          } catch (e) {}
        }
      }
    }, 3500);
  }

  async function pollChatMessages(chatId, forceRender = false) {
    try {
      const res = await fetch(`/api/messages?chatId=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (data.ok) {
        const chat = chats.find(c => c.id === chatId);
        if (chat) {
          chat.status = data.status;
          chat.shareUrl = data.shareUrl || chat.shareUrl;
          chat.taskUrl = data.taskUrl || chat.taskUrl;
          chat.messages = data.messages || [];
        }

        // If this is the active chat, update UI
        if (chatId === activeChatId) {
          updateStatusBadge(data.status);
          updateShareGroupUI(data.shareUrl);
          renderConversationMessages(data.messages || [], data.status, data.shareUrl);
        }
        renderChatList();
      }
    } catch (err) {
      console.warn("Poll message error:", err);
    }
  }

  function renderConversationMessages(messages, status, shareUrl) {
    messagesFlow.innerHTML = "";

    if (!messages || messages.length === 0) {
      const runningRow = document.createElement("div");
      runningRow.className = "message-row assistant";
      runningRow.innerHTML = `
        <div class="msg-avatar">M</div>
        <div class="msg-body">
          <span class="msg-sender">Manus</span>
          <div class="msg-bubble">
            <div class="status-step-card">
              <div class="step-spinner"></div>
              <span>Initializing task and planning steps in the background...</span>
            </div>
          </div>
        </div>
      `;
      messagesFlow.appendChild(runningRow);
      scrollToBottom();
      return;
    }

    messages.forEach((msg) => {
      const isUser = (msg.role || "").toLowerCase().includes("user");
      const row = document.createElement("div");
      row.className = `message-row ${isUser ? "user" : "assistant"}`;

      const avatarText = isUser ? "Y" : "M";
      const senderText = isUser ? "You" : "Manus";

      let bodyHtml = "";
      if (msg.kind === "status") {
        bodyHtml = `
          <div class="status-step-card">
            <div class="step-spinner"></div>
            <span>${escapeHtml(msg.content)}</span>
          </div>
        `;
      } else {
        bodyHtml = formatMarkdown(msg.content || "");
      }

      // Attachments rendering
      let attachmentsHtml = "";
      if (msg.attachments && msg.attachments.length > 0) {
        attachmentsHtml = msg.attachments.map(att => {
          if (att.type === "image" && att.url) {
            return `
              <div class="attachment-card">
                <a href="${att.url}" target="_blank" rel="noopener noreferrer">
                  <img src="${att.url}" alt="${escapeHtml(att.label)}" />
                </a>
              </div>
            `;
          }
          if (att.type === "video" && att.url) {
            return `
              <div class="attachment-card">
                <video src="${att.url}" controls></video>
              </div>
            `;
          }
          return `
            <div class="attachment-card">
              <span>📄</span>
              <a href="${att.url || '#'}" target="_blank" style="color:var(--accent-cyan);text-decoration:none;font-weight:600;">
                ${escapeHtml(att.label || "Deliverable")}
              </a>
              ${att.accessible ? '<span style="font-size:11px;color:var(--text-dim);">Ready</span>' : ''}
            </div>
          `;
        }).join("");
      }

      row.innerHTML = `
        <div class="msg-avatar">${avatarText}</div>
        <div class="msg-body">
          <span class="msg-sender">${senderText}</span>
          <div class="msg-bubble">
            ${bodyHtml}
            ${attachmentsHtml}
          </div>
        </div>
      `;

      messagesFlow.appendChild(row);
    });

    // If task is running, show active step indicator
    if (status === "running") {
      const stepRow = document.createElement("div");
      stepRow.className = "message-row assistant";
      stepRow.innerHTML = `
        <div class="msg-avatar">M</div>
        <div class="msg-body">
          <span class="msg-sender">Manus</span>
          <div class="msg-bubble">
            <div class="status-step-card">
              <div class="step-spinner"></div>
              <span>Agent is actively executing instructions, browsing, or computing deliverables...</span>
            </div>
          </div>
        </div>
      `;
      messagesFlow.appendChild(stepRow);
    }

    // CRITICAL REQUIREMENT: When task is complete (or stopped/waiting), render Public Chat URL banner!
    if (shareUrl && (status === "stopped" || status === "waiting")) {
      const shareBanner = document.createElement("div");
      shareBanner.className = "public-share-banner";
      shareBanner.innerHTML = `
        <div class="share-banner-header">
          <span>🎉 Task Complete • Public Manus Chat URL</span>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:0;">
          This background session is publicly viewable without requiring authentication:
        </p>
        <div class="share-banner-input-group">
          <input type="text" readonly value="${escapeHtml(shareUrl)}" id="bannerShareInput" />
          <button class="btn-banner-copy" id="bannerCopyBtn" type="button">📋 Copy Link</button>
          <a href="${shareUrl}" target="_blank" rel="noopener noreferrer" class="btn-banner-open">Open Chat ↗</a>
        </div>
      `;

      shareBanner.querySelector("#bannerCopyBtn").addEventListener("click", () => {
        navigator.clipboard.writeText(shareUrl);
        showToast("Public chat link copied to clipboard!");
      });

      messagesFlow.appendChild(shareBanner);
    }

    scrollToBottom();
  }

  function updateStatusBadge(status) {
    const s = (status || "stopped").toLowerCase();
    currentChatStatus.className = `status-badge ${s}`;
    if (s === "running") currentChatStatus.textContent = "● Running in background";
    else if (s === "stopped") currentChatStatus.textContent = "✓ Completed";
    else if (s === "waiting") currentChatStatus.textContent = "⚠ Waiting for Input";
    else if (s === "error") currentChatStatus.textContent = "✕ Error";
    else currentChatStatus.textContent = status || "Idle";
  }

  function updateShareGroupUI(shareUrl) {
    if (shareUrl) {
      shareActionGroup.style.display = "flex";
      openShareUrlLink.href = shareUrl;
    } else {
      shareActionGroup.style.display = "none";
    }
  }

  function scrollToBottom() {
    chatStreamContainer.scrollTop = chatStreamContainer.scrollHeight;
  }

  // -------------------------------------------------------------
  // File Attachment Handling
  // -------------------------------------------------------------

  function handleFileSelection(e) {
    const files = Array.from(e.target.files || []);
    selectedFiles.push(...files);
    renderAttachmentTray();
    fileInput.value = "";
  }

  function renderAttachmentTray() {
    attachmentTray.innerHTML = "";
    selectedFiles.forEach((file, index) => {
      const pill = document.createElement("div");
      pill.className = "attachment-pill";
      pill.innerHTML = `
        <span>📎 ${escapeHtml(file.name)}</span>
        <span class="remove-file-btn" data-index="${index}">✕</span>
      `;
      pill.querySelector(".remove-file-btn").addEventListener("click", () => {
        selectedFiles.splice(index, 1);
        renderAttachmentTray();
      });
      attachmentTray.appendChild(pill);
    });
  }

  function clearSelectedFiles() {
    selectedFiles = [];
    attachmentTray.innerHTML = "";
  }

  // -------------------------------------------------------------
  // Helpers: Markdown & Formatting
  // -------------------------------------------------------------

  function formatMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);

    // Code blocks
    html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (match, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold & Italics
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Markdown Links
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);text-decoration:underline;">$1</a>');

    // Auto link raw URLs
    html = html.replace(/(^|[^"])((?:https?:\/\/)[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);text-decoration:underline;">$2</a>');

    // Paragraphs & Linebreaks
    const paragraphs = html.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`);
    return paragraphs.join("");
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return "";
    const date = new Date(isoString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => {
      toastEl.classList.remove("show");
    }, 3200);
  }

  // Kickoff
  init();
})();
