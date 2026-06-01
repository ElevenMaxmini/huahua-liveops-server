import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createHash } from "crypto";
import dns from "dns/promises";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const analyticsFile = path.join(dataDir, "analytics.ndjson");
const progressionFile = path.join(dataDir, "progression.json");

fs.mkdirSync(dataDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function envNumber(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "TRUE";
}

function stableId(prefix, seed) {
  return prefix + "_" + createHash("sha256").update(String(seed)).digest("hex").slice(0, 24);
}

function describeError(error) {
  if (!error) return "unknown_error";
  if (error.payload && error.payload.errmsg) {
    return "wechat_api_error:" + error.payload.errmsg;
  }
  if (error.cause && error.cause.message) {
    return error.message + " | cause: " + error.cause.message;
  }
  if (error.message) return error.message;
  return String(error);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function fetchJson(url, options = {}) {
  return new Promise(function doFetch(resolve, reject) {
    const request = https.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        // Cloud run currently reaches WeChat through a self-signed chain.
        // Limit the relaxation to this upstream request instead of disabling TLS globally.
        rejectUnauthorized: options.rejectUnauthorized !== false
      },
      function onResponse(response) {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", function onData(chunk) {
          body += chunk;
        });
        response.on("end", function onEnd() {
          try {
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode || 0,
              json: body ? JSON.parse(body) : {}
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.end(options.body || "");
  });
}

function buildRemoteConfig() {
  return {
    version: 1,
    values: {
      lifeRecoverMinutes: envNumber("LIFE_RECOVER_MINUTES", 15),
      rewardedCoinMultiplier: envNumber("REWARDED_COIN_MULTIPLIER", 3),
      rewardedReviveLife: envNumber("REWARDED_REVIVE_LIFE", 1),
      shareRewardCoins: envNumber("SHARE_REWARD_COINS", 0),
      shareRewardSunshine: envNumber("SHARE_REWARD_SUNSHINE", 0),
      featureFlags: {
        rewardedAds: true,
        shareEntry: true,
        loginPanel: true,
        analytics: true,
        remoteConfig: true
      }
    },
    share: {
      title: process.env.SHARE_TITLE || "花花达人，来帮我一起点亮治愈花园",
      imageUrl: process.env.SHARE_IMAGE_URL || "",
      query: process.env.SHARE_QUERY || "shareSource=default",
      withShareTicket: true
    },
    ads: {
      rewardedVideoAdUnitId: process.env.REWARDED_VIDEO_AD_UNIT_ID || ""
    },
    analytics: {},
    copy: {}
  };
}

async function fetchCode2Session(code) {
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) {
    return {
      openId: "",
      unionId: "",
      sessionKey: "",
      hasWechatIdentity: false,
      fallback: true
    };
  }
  const url =
    "https://api.weixin.qq.com/sns/jscode2session" +
    "?appid=" + encodeURIComponent(appId) +
    "&secret=" + encodeURIComponent(appSecret) +
    "&js_code=" + encodeURIComponent(code) +
    "&grant_type=authorization_code";
  const response = await fetchJson(url, { rejectUnauthorized: false });
  const payload = response.json;
  if (!response.ok || payload.errcode) {
    const message = payload.errmsg || "jscode2session failed";
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return {
    openId: payload.openid || "",
    unionId: payload.unionid || "",
    sessionKey: payload.session_key || "",
    hasWechatIdentity: !!payload.openid,
    fallback: false
  };
}

async function fetchDouyinCode2Session(code) {
  const appId = process.env.DOUYIN_APP_ID;
  const appSecret = process.env.DOUYIN_APP_SECRET;
  if (!appId || !appSecret) {
    return {
      openId: "",
      unionId: "",
      sessionKey: "",
      hasDouyinIdentity: false,
      fallback: true
    };
  }
  const url =
    "https://developer.toutiao.com/api/apps/v2/jscode2session" +
    "?appid=" + encodeURIComponent(appId) +
    "&secret=" + encodeURIComponent(appSecret) +
    "&code=" + encodeURIComponent(code) +
    "&anonymous_code=";
  const response = await fetchJson(url);
  const payload = response.json || {};
  if (!response.ok || payload.err_no) {
    const error = new Error(payload.err_tips || payload.errmsg || "douyin jscode2session failed");
    error.payload = payload;
    throw error;
  }
  const data = payload.data || payload;
  return {
    openId: data.openid || data.open_id || "",
    unionId: data.unionid || data.union_id || "",
    sessionKey: data.session_key || "",
    hasDouyinIdentity: !!(data.openid || data.open_id),
    fallback: false
  };
}

app.get("/health", function health(req, res) {
  res.json({
    ok: true,
    service: "findcows-liveops-server",
    version: "douyin-cloud-progress-v1",
    routes: ["/wx/login", "/wx/remote-config", "/wx/analytics", "/douyin/login", "/progression"],
    time: Date.now()
  });
});

app.get("/health/wechat-config", function healthWechatConfig(req, res) {
  res.json({
    ok: true,
    data: {
      hasAppId: !!process.env.WECHAT_APP_ID,
      hasAppSecret: !!process.env.WECHAT_APP_SECRET,
      appIdSuffix: process.env.WECHAT_APP_ID ? String(process.env.WECHAT_APP_ID).slice(-6) : ""
    }
  });
});

app.get("/health/wechat-egress", async function healthWechatEgress(req, res) {
  const result = {
    dnsOk: false,
    dnsAddress: "",
    fetchOk: false,
    fetchStatus: 0,
    error: ""
  };
  try {
    const dnsResult = await dns.lookup("api.weixin.qq.com");
    result.dnsOk = true;
    result.dnsAddress = dnsResult && dnsResult.address ? dnsResult.address : "";
  } catch (error) {
    result.error = "dns:" + describeError(error);
  }
  try {
    const response = await fetchJson("https://api.weixin.qq.com", {
      rejectUnauthorized: false
    });
    result.fetchOk = !!response;
    result.fetchStatus = response ? response.status : 0;
  } catch (error) {
    result.error = result.error ? result.error + " | fetch:" + describeError(error) : "fetch:" + describeError(error);
  }
  res.json({
    ok: result.dnsOk || result.fetchOk,
    data: result
  });
});

app.post("/wx/login", async function login(req, res) {
  const body = req.body || {};
  const code = body.code || "";
  const guestId = body.guestId || stableId("guest", Date.now());
  try {
    const session = code
      ? await fetchCode2Session(code)
      : {
          openId: "",
          unionId: "",
          sessionKey: "",
          hasWechatIdentity: false,
          fallback: true
        };
    const identitySeed = session.openId || guestId;
    const userId = session.openId ? stableId("u", identitySeed) : guestId;
    res.json({
      ok: true,
      data: {
        userId,
        openId: session.openId,
        unionId: session.unionId,
        guestId,
        hasWechatIdentity: session.hasWechatIdentity
      }
    });
  } catch (error) {
    console.error("[wx/login] fallback", {
      message: describeError(error),
      codePresent: !!code,
      hasAppId: !!process.env.WECHAT_APP_ID,
      hasAppSecret: !!process.env.WECHAT_APP_SECRET
    });
    res.status(200).json({
      ok: true,
      data: {
        userId: guestId,
        openId: "",
        unionId: "",
        guestId,
        hasWechatIdentity: false,
        fallbackReason: describeError(error)
      }
    });
  }
});

app.post("/douyin/login", async function douyinLogin(req, res) {
  const body = req.body || {};
  const code = body.code || "";
  const guestId = body.guestId || stableId("douyin_guest", Date.now());
  try {
    const session = code
      ? await fetchDouyinCode2Session(code)
      : {
          openId: "",
          unionId: "",
          sessionKey: "",
          hasDouyinIdentity: false,
          fallback: true
        };
    const openId = session.openId || guestId;
    const identitySeed = openId;
    const userId = session.openId ? stableId("du", identitySeed) : guestId;
    res.json({
      ok: true,
      openId,
      unionId: session.unionId,
      sessionToken: userId,
      nickName: "抖音玩家",
      data: {
        userId,
        openId,
        unionId: session.unionId,
        guestId,
        hasDouyinIdentity: session.hasDouyinIdentity
      }
    });
  } catch (error) {
    console.error("[douyin/login] fallback", {
      message: describeError(error),
      codePresent: !!code,
      hasAppId: !!process.env.DOUYIN_APP_ID,
      hasAppSecret: !!process.env.DOUYIN_APP_SECRET
    });
    res.status(200).json({
      ok: true,
      openId: guestId,
      unionId: "",
      sessionToken: guestId,
      nickName: "抖音玩家",
      fallbackReason: describeError(error),
      data: {
        userId: guestId,
        openId: guestId,
        unionId: "",
        guestId,
        hasDouyinIdentity: false
      }
    });
  }
});

app.post("/progression", function progression(req, res) {
  const body = req.body || {};
  const action = body.action || "";
  const channel = body.channel || "douyin";
  const openId = body.openId || "";
  if (!openId) {
    res.status(400).json({
      ok: false,
      error: "openId_required"
    });
    return;
  }

  const key = channel + ":" + openId;
  const store = readJsonFile(progressionFile, {});
  if (action === "load") {
    const record = store[key] || null;
    res.json({
      ok: true,
      version: record ? record.version || 1 : 1,
      updatedAt: record ? record.updatedAt || 0 : 0,
      state: record ? record.state || null : null
    });
    return;
  }

  if (action === "save") {
    store[key] = {
      version: Number(body.version) || 1,
      updatedAt: Number(body.updatedAt) || Date.now(),
      state: body.state || null
    };
    writeJsonFile(progressionFile, store);
    res.json({
      ok: true
    });
    return;
  }

  res.status(400).json({
    ok: false,
    error: "unsupported_action"
  });
});

app.post("/wx/remote-config", function remoteConfig(req, res) {
  res.json({
    ok: true,
    data: buildRemoteConfig()
  });
});

app.post("/wx/analytics", function analytics(req, res) {
  const payload = {
    time: new Date().toISOString(),
    body: req.body || {}
  };
  fs.appendFileSync(analyticsFile, JSON.stringify(payload) + "\n", "utf8");
  if (boolEnv("LOG_ANALYTICS", true)) {
    console.log("[analytics]", JSON.stringify(payload.body));
  }
  res.json({
    ok: true
  });
});

const port = envNumber("PORT", 3000);
app.listen(port, function onListen() {
  console.log("FindCows liveops server listening on http://127.0.0.1:" + port);
});
