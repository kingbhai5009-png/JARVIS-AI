
require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = "https://generativelanguage.googleapis.com/v1beta";

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  console.log(new Date().toLocaleTimeString(), req.method, req.url);
  next();
});

app.use(express.static(path.join(__dirname, "dist")));

app.get("/api/status", (req, res) => {
  res.json({
    name: "JARVIS AI",
    status: "Online",
    version: "6.0",
    brain: "Gemini",
    memory: true
  });
});

async function safeFetch(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

let cachedModels = [];
let modelsTime = 0;

async function getModels(apiKey) {
  if (cachedModels.length && Date.now() - modelsTime < 300000) {
    return cachedModels;
  }

  const response = await safeFetch(
    `${API_URL}/models?pageSize=100`,
    { headers: { "x-goog-api-key": apiKey } },
    12000
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Model discovery failed");
  }

  const models = (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(m => m.toLowerCase().includes("flash"));

  models.sort((a, b) =>
    Number(!a.toLowerCase().includes("lite")) -
    Number(!b.toLowerCase().includes("lite"))
  );

  cachedModels = [...new Set(models)].slice(0, 5);
  modelsTime = Date.now();

  return cachedModels;
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      ["user", "model"].includes(item.role) &&
      typeof item.text === "string" &&
      item.text.trim()
    )
    .slice(-12)
    .map(item => ({
      role: item.role,
      parts: [{ text: item.text.slice(0, 4000) }]
    }));
}

async function askGemini(model, contents, apiKey) {
  const response = await safeFetch(
    `${API_URL}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text:
              "You are JARVIS, a smart and friendly AI assistant. " +
              "Reply in the same language as the user. " +
              "Understand previous conversation and maintain context. " +
              "Use simple Hindi or Hinglish when appropriate. " +
              "Give accurate, clear, helpful and age-appropriate answers. " +
              "Do not claim to remember information that is not in the conversation."
          }]
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500
        }
      })
    },
    30000
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || `Gemini HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!reply) throw new Error("Gemini returned an empty response");

  return reply;
}

app.post("/api/chat", async (req, res) => {
  console.log("JARVIS CHAT REQUEST RECEIVED");

  const apiKey = process.env.GEMINI_API_KEY;
  const message = req.body?.message;

  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: ".env mein GEMINI_API_KEY nahi mili."
    });
  }

  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 4000
  ) {
    return res.status(400).json({
      success: false,
      error: "Message sahi nahi hai."
    });
  }

  const history = cleanHistory(req.body?.history);

  const contents = [
    ...history,
    { role: "user", parts: [{ text: message.trim() }] }
  ];

  let models = [];

  try {
    models = await getModels(apiKey);
  } catch (error) {
    console.log("MODEL DISCOVERY:", error.message);

    if (process.env.GEMINI_MODEL) {
      models = [process.env.GEMINI_MODEL];
    }
  }

  if (!models.length && process.env.GEMINI_MODEL) {
    models = [process.env.GEMINI_MODEL];
  }

  if (!models.length) {
    return res.status(502).json({
      success: false,
      error: "Koi Gemini Flash model available nahi hai."
    });
  }

  const errors = [];

  for (const model of models) {
    try {
      console.log("Trying model:", model);

      const reply = await askGemini(model, contents, apiKey);

      console.log("SUCCESS:", model);

      return res.json({
        success: true,
        reply,
        model
      });

    } catch (error) {
      console.log("FAILED:", model, error.message);
      errors.push(error.message);

      if ([401, 403].includes(error.status)) break;
    }
  }

  res.status(502).json({
    success: false,
    error: "Gemini jawab nahi de pa raha. Thodi der baad try karein.",
    details: errors
  });
});

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error.message);

  if (res.headersSent) return next(error);

  res.status(error.status || 500).json({
    success: false,
    error: error.status === 400
      ? "Invalid JSON request."
      : "Internal server error."
  });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("================================");
    console.log("       JARVIS AI VERSION 6.0");
    console.log("================================");
    console.log("Gemini AI: ON");
    console.log("Conversation Context: ON");
    console.log("Server: http://localhost:" + PORT);
  });
}

module.exports = app;
