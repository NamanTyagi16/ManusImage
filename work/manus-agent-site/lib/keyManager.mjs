import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const MANUS_BASE_URL = "https://api.manus.ai/v2";

export class KeyManager {
  constructor(keysFilePath) {
    this.keysFilePath = keysFilePath;
    this.keyPool = [];
  }

  async init(initialPool = []) {
    this.keyPool = initialPool;
    if (existsSync(this.keysFilePath)) {
      try {
        const content = await readFile(this.keysFilePath, "utf8");
        this.keyPool = JSON.parse(content || "[]");
      } catch (err) {
        console.error("Error reading keys file:", err.message);
      }
    }
  }

  async save() {
    try {
      await writeFile(this.keysFilePath, JSON.stringify(this.keyPool, null, 2), "utf8");
    } catch (err) {
      console.error("Error saving keys file:", err.message);
    }
  }

  maskKey(key) {
    if (!key || key.length < 10) return "••••••••";
    return key.slice(0, 7) + "••••••••" + key.slice(-4);
  }

  getSafeKeys() {
    const now = Date.now();
    return this.keyPool.map(k => ({
      id: k.id,
      label: k.label,
      masked: this.maskKey(k.key),
      status: k.cooldownUntil && k.cooldownUntil > now ? "cooldown" : k.status,
      cooldownUntil: k.cooldownUntil || null,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      credits: k.credits,
      user: k.user
    }));
  }

  getKey(keyId) {
    if (!keyId || keyId === "auto") {
      return this.getEligibleKey();
    }
    return this.keyPool.find(k => k.id === keyId) || null;
  }

  /**
   * Credit-weighted selection of the best eligible key.
   * Avoids depleted, error, and cooldown keys.
   */
  getEligibleKey(excludeId = null) {
    const now = Date.now();
    const eligible = this.keyPool.filter(k => {
      if (excludeId && k.id === excludeId) return false;
      if (k.status !== "active") return false;
      if (k.cooldownUntil && k.cooldownUntil > now) return false;
      if (k.credits && k.credits.total <= 0 && k.credits.free <= 0) return false;
      return true;
    });

    if (!eligible.length) return null;

    // Sort by credits descending (credit-weighted), tie-break by LRU lastUsedAt
    eligible.sort((a, b) => {
      const aCredits = a.credits?.total ?? a.credits?.free ?? 50;
      const bCredits = b.credits?.total ?? b.credits?.free ?? 50;
      if (bCredits !== aCredits) return bCredits - aCredits;

      const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return aTime - bTime;
    });

    return eligible[0];
  }

  async markKeyUsed(keyId) {
    const key = this.keyPool.find(k => k.id === keyId);
    if (key) {
      key.lastUsedAt = new Date().toISOString();
      await this.save();
    }
  }

  async markKeyQuotaExhausted(keyId) {
    const key = this.keyPool.find(k => k.id === keyId);
    if (key) {
      key.status = "depleted";
      if (key.credits) {
        key.credits.total = 0;
        key.credits.free = 0;
      }
      await this.save();
    }
  }

  async markKeyRateLimited(keyId, retryAfterMs = 60000) {
    const key = this.keyPool.find(k => k.id === keyId);
    if (key) {
      key.cooldownUntil = Date.now() + retryAfterMs;
      await this.save();
    }
  }

  async markKeyCooldown(keyId, retryAfterMs = 60000, reason = null) {
    const key = this.keyPool.find(k => k.id === keyId);
    if (key) {
      key.cooldownUntil = Date.now() + retryAfterMs;
      key.pauseReason = reason || "Cooldown";
      await this.save();
    }
  }

  /**
   * Validates a raw API key against Manus API v2.
   * Separately detects invalid auth, quota exhaustion, and valid active keys.
   */
  async validateKey(rawKey) {
    const cleanKey = String(rawKey || "").trim();
    if (!cleanKey) {
      return { ok: false, valid: false, error: "API key is required" };
    }

    try {
      // 1. Check user.me for auth
      const userRes = await fetch(`${MANUS_BASE_URL}/user.me`, {
        headers: { "x-manus-api-key": cleanKey }
      });

      if (!userRes.ok) {
        if (userRes.status === 401 || userRes.status === 403) {
          return {
            ok: false,
            valid: false,
            status: "invalid",
            error: "Authentication failed: Invalid Manus API key"
          };
        }
        if (userRes.status === 429) {
          return {
            ok: false,
            valid: false,
            status: "rate_limited",
            error: "API rate limit reached on this key"
          };
        }
        return {
          ok: false,
          valid: false,
          status: "error",
          error: `API error (HTTP ${userRes.status})`
        };
      }

      const userData = await userRes.json();

      // 2. Check credits
      let credits = { total: 0, free: 0, refresh: 0, interval: "daily" };
      let isDepleted = false;

      try {
        const credRes = await fetch(`${MANUS_BASE_URL}/usage.availableCredits`, {
          headers: { "x-manus-api-key": cleanKey }
        });
        if (credRes.ok) {
          const credData = await credRes.json();
          credits = {
            total: credData.total_credits ?? 0,
            free: credData.free_credits ?? 0,
            refresh: credData.refresh_credits ?? 0,
            interval: credData.refresh_interval || "daily"
          };
          if (credits.total <= 0 && credits.free <= 0) {
            isDepleted = true;
          }
        }
      } catch (e) {
        console.warn("Credits check warning:", e.message);
      }

      return {
        ok: true,
        valid: true,
        status: isDepleted ? "depleted" : "active",
        user: {
          name: userData.name || "",
          email: userData.email || ""
        },
        credits,
        masked: this.maskKey(cleanKey)
      };
    } catch (err) {
      return {
        ok: false,
        valid: false,
        status: "network_error",
        error: `Network error connecting to Manus API: ${err.message}`
      };
    }
  }

  /**
   * Adds and registers a validated key into the pool.
   */
  async addValidatedKey({ rawKey, label, validationResult }) {
    const cleanKey = String(rawKey || "").trim();
    let entry = this.keyPool.find(k => k.key === cleanKey);

    if (entry) {
      // Update existing
      entry.status = validationResult.status || "active";
      entry.credits = validationResult.credits;
      entry.user = validationResult.user;
      if (label) entry.label = label;
      await this.save();
      return entry;
    }

    entry = {
      id: "key_" + Math.random().toString(36).slice(2, 10),
      key: cleanKey,
      label: label || validationResult.user?.name || validationResult.user?.email || `Key ${this.keyPool.length + 1}`,
      status: validationResult.status || "active",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      cooldownUntil: null,
      credits: validationResult.credits,
      user: validationResult.user
    };

    this.keyPool.push(entry);
    await this.save();
    return entry;
  }
}
