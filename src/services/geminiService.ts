import { GoogleGenAI } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import type { CognitiveError, CognitiveMetrics } from '../types';

const getApiKey = (): string => {
  if (typeof window !== 'undefined' && window.localStorage) {
    const storedKey = window.localStorage.getItem('neuroflow_api_key');
    if (storedKey) return storedKey;
  }
  // Try process.env.API_KEY or process.env.GEMINI_API_KEY (injected by Vite define) or VITE_ prefix
  const key = (typeof process !== 'undefined' && process.env ? (process.env.API_KEY || process.env.GEMINI_API_KEY) : '') || import.meta.env.VITE_GEMINI_API_KEY;
  return key || '';
};

const model = "gemini-2.5-flash";

export interface AnalysisResponse extends CognitiveMetrics {
  message: string;
  lexicalRarityScore: number;
  switchClassifications: { from: string; to: string; type: 'semantic' | 'phonological' | 'unrelated' }[];
}

export const analyzeTranscript = async (
  transcript: string, 
  letter: string, 
  errorsObservedDuringTest: CognitiveError[],
  duration: number
): Promise<AnalysisResponse> => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Gemini API Key is not configured. Please define GEMINI_API_KEY in your .env.local file.");
  }
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
    You are a neuropsychological assessor AI designed to evaluate a verbal fluency cognitive test.
    The user was asked to name as many animals as they can starting with the letter "${letter.toUpperCase()}" in ${duration} seconds.
    
    Raw transcript: "${transcript}"
    Real-time errors logged: ${JSON.stringify(errorsObservedDuringTest)}
 
    Perform the following analysis steps:
    1. Identify all valid, unique animal names starting with "${letter.toUpperCase()}". 
       - Be lenient with speech-to-text typos (e.g. "limb"/"lamp" -> "lamb", "line" -> "lion") or plural forms, matching the intent.
       - Discard non-animal words.
       - Discard duplicate mentions of the same animal.
       
    2. Classify the valid animals into distinct semantic clusters based on their habitat, family, or type (e.g., 'felines', 'canines', 'marine', 'farm', 'birds', 'reptiles', 'insects', 'forest'). Keep the category labels short and descriptive.
    
    3. Calculate Clinical Metrics:
       - score: Number of unique, valid animals.
       - clusters: An array of objects: { category: string, animals: string[] }.
       - switchingCount: The number of times the user transitioned from one semantic category to another. 
         (Example: If they named: [lion, leopard] (felines) -> [whale] (marine) -> [lamb] (farm), they switched 2 times).
       - clusterSizeAverage: The average size of the semantic clusters named.
       - errors: Identify errors in the transcript. Group them as:
         - 'repetition': The same animal named more than once.
         - 'wrong-letter': Words starting with another letter.
         - 'non-animal': Words that are not animals.
         Integrate the pre-logged real-time errors in this array.

    4. Generate a warm, professional, encouraging feedback message (2-3 sentences) representing a clinical verbal fluency coach speaking directly to the user:
       - First, provide a positive affirmation acknowledging their performance based on their score (Score 0-2: gentle and warm; Score 3-5: recognizing solid effort; Score 6+: enthusiastic praise).
       - Second, analyze the semantic categories of animals they named. If they named animals in only a few categories (e.g. only land mammals or farm animals), suggest trying other categories next time (like birds, insects, reptiles, or marine animals) and provide 2-3 specific example animals starting with the letter "${letter.toUpperCase()}" that they could have named.
       - Ensure the tone is supportive, clear, and therapeutic.

    5. Calculate Advanced Neurolinguistic Diagnostics:
       - lexicalRarityScore: Rate the average vocabulary complexity/rarity of the valid animals named on a scale of 1.0 (very basic/common, e.g. dog, cat, lion) to 5.0 (highly advanced/exotic, e.g. lemur, lamprey, locust, loggerhead turtle) based on standard lexical familiarity.
       - switchClassifications: For each transition between consecutive clusters in your 'clusters' array (e.g. cluster 1 to cluster 2, cluster 2 to cluster 3, etc.), classify the switch type as:
         - 'semantic' if they switched to a category related by taxonomy/habitat (e.g. felines to canines, or farm animals to marine animals)
         - 'phonological' if they switched because of sound similarity / alliteration (e.g. lamb to llama, bear to bee)
         - 'unrelated' if there is no obvious connection.

    Return your response ONLY as a JSON object matching this structure. Do not include markdown formatting like \`\`\`json.
    {
      "score": number,
      "animals": string[],
      "clusters": [
        { "category": "category name", "animals": ["animal1", "animal2"] }
      ],
      "switchingCount": number,
      "clusterSizeAverage": number,
      "errors": [
        { "word": "word", "type": "repetition" | "wrong-letter" | "non-animal" }
      ],
      "message": "encouraging feedback with semantic suggestions",
      "lexicalRarityScore": number,
      "switchClassifications": [
        { "from": "category A", "to": "category B", "type": "semantic" | "phonological" | "unrelated" }
      ]
    }
  `;

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            temperature: 0.2,
        }
    });

    const text = response.text;
    if (!text) {
        throw new Error("No text returned from Gemini API");
    }
    let jsonStr = text.trim();
    
    // Clean up any markdown code fence wrappers
    const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
    const match = jsonStr.match(fenceRegex);
    if (match && match[2]) {
      jsonStr = match[2].trim();
    }
    
    const parsedData = JSON.parse(jsonStr) as AnalysisResponse;
    
    // Fallback default checks
    if (typeof parsedData.score !== 'number' || !Array.isArray(parsedData.animals) || typeof parsedData.message !== 'string') {
        throw new Error("Invalid response format received from Gemini.");
    }

    return parsedData;

  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw new Error("Failed to get cognitive analysis from Gemini service.");
  }
};

// WAV wrapping helper for raw PCM 24kHz audio returned by Gemini
function pcmToWav(pcmBuffer: ArrayBuffer, sampleRate: number = 24000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcmBuffer.byteLength);
  const view = new DataView(buffer);

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBuffer.byteLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 16-bit Mono (rate * 2)
  view.setUint16(32, 2, true); // Block align (2 bytes)
  view.setUint16(34, 16, true); // 16-bit
  writeString(view, 36, 'data');
  view.setUint32(40, pcmBuffer.byteLength, true);

  const dst = new Uint8Array(buffer, 44);
  dst.set(new Uint8Array(pcmBuffer));

  return buffer;
}

// Speaks a message using Gemini's native multimodal audio output
export const speakWithGemini = async (text: string): Promise<string> => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Gemini API Key is not configured.");
  }
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts", // Use gemini-2.5-flash-preview-tts for audio response support
    contents: `Read the following clinical message with a supportive, warm, professional voice: "${text}"`,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Aoede" // Choose Kore, Puck, Aoede, Charon, Fenrir
          }
        }
      }
    }
  });

  const candidate = response.candidates?.[0];
  const part = candidate?.content?.parts?.find(p => p.inlineData);
  if (part && part.inlineData && part.inlineData.data) {
    const base64Pcm = part.inlineData.data;
    
    // Decode base64 to binary ArrayBuffer
    const binaryString = atob(base64Pcm);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Wrap PCM in WAV header
    const wavBuffer = pcmToWav(bytes.buffer, 24000);
    
    // Convert ArrayBuffer to base64
    const wavBytes = new Uint8Array(wavBuffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < wavBytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(wavBytes.subarray(i, i + chunk)));
    }
    const base64Wav = btoa(binary);
    return `data:audio/wav;base64,${base64Wav}`;
  }
  
  throw new Error("No audio data returned from Gemini API");
};
