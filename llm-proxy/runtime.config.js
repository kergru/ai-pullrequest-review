// Runtime overrides for llm-proxy (POC)
// Edit values and restart the server/container to apply changes.
// If you prefer JSON, you can instead create runtime.config.json with the same keys.

export default {
  // Switch to enable legacy OpenAI-compatible client (devstral-small2-24b) alongside the main OpenAI Responses client (gpt-4.1-mini)
  legacyEnabled: true,

    // Max chars to consider for diffing (to prevent OOM on large inputs)
  maxDiffChars: 120000,

  // Optional model overrides
  // If set, they override environment variables in the respective clients
  openaiModel: "gpt-4.1-mini",

  // nexnet models
  legacyModel: "devstral-small2-24b",
};
