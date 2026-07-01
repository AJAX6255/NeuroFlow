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
  console.log("Testing audio generation with gemini-2.5-flash-preview-tts...");
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: "Hello, this is a test of Gemini TTS.",
      config: {
        responseModalities: ["AUDIO"],
      }
    });
    console.log("Success with gemini-2.5-flash-preview-tts!");
    const candidate = response.candidates?.[0];
    const part = candidate?.content?.parts?.find(p => p.inlineData);
    if (part && part.inlineData && part.inlineData.data) {
      console.log("Audio data found! Length:", part.inlineData.data.length);
    } else {
      console.log("No audio inlineData found in response parts:", JSON.stringify(candidate?.content?.parts));
    }
  } catch (error) {
    console.error("Failed with gemini-2.5-flash-preview-tts:", error.message || error);
  }

  console.log("\nTesting audio generation with gemini-3.1-flash-tts-preview...");
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: "Hello, this is a test of Gemini TTS.",
      config: {
        responseModalities: ["AUDIO"],
      }
    });
    console.log("Success with gemini-3.1-flash-tts-preview!");
    const candidate = response.candidates?.[0];
    const part = candidate?.content?.parts?.find(p => p.inlineData);
    if (part && part.inlineData && part.inlineData.data) {
      console.log("Audio data found! Length:", part.inlineData.data.length);
    } else {
      console.log("No audio inlineData found in response parts:", JSON.stringify(candidate?.content?.parts));
    }
  } catch (error) {
    console.error("Failed with gemini-3.1-flash-tts-preview:", error.message || error);
  }
}

run();
