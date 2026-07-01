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

console.log("API Key loaded:", apiKey ? "YES (starts with " + apiKey.substring(0, 8) + ")" : "NO");

if (!apiKey) {
  console.error("GEMINI_API_KEY not found in .env.local");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function run() {
  console.log("Calling Gemini API...");
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Hello, this is a test. Please respond with 'OK'.",
    });
    console.log("Response text:", response.text);
  } catch (error) {
    console.error("Error calling Gemini API:", error);
  }
}

run();
