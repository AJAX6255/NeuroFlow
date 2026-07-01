import { GoogleGenAI } from "@google/genai";
import fs from "fs";

let apiKey = "";
try {
  const envContent = fs.readFileSync(".env.local", "utf8");
  const match = envContent.match(/GEMINI_API_KEY\s*=\s*(.+)/);
  if (match && match[1]) {
    apiKey = match[1].trim();
  }
} catch (e) {
  console.error("Failed to read .env.local:", e.message);
}

if (!apiKey) {
  console.error("GEMINI_API_KEY not found in .env.local");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function run() {
  console.log("Listing available models...");
  try {
    const response = await ai.models.list();
    console.log("Raw response:", JSON.stringify(response, null, 2));
  } catch (error) {
    console.error("Failed to list models:", error.message || error);
  }
}

run();
