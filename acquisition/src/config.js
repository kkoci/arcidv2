require("dotenv").config();

module.exports = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  MODEL: process.env.MODEL || "claude-sonnet-4-6",
};
