import { GoogleGenAI } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import type { CognitiveError, CognitiveMetrics } from '../types';

if (!process.env.API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const model = "gemini-2.5-flash";

export interface AnalysisResponse extends CognitiveMetrics {
  message: string;
}

export const analyzeTranscript = async (
  transcript: string, 
  letter: string, 
  errorsObservedDuringTest: CognitiveError[]
): Promise<AnalysisResponse> => {
  
  const prompt = `
    You are a neuropsychological assessor AI designed to evaluate a verbal fluency cognitive test.
    The user was asked to name as many animals as they can starting with the letter "${letter.toUpperCase()}" in 30 seconds.
    
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

    4. Generate a single-sentence encouraging feedback message based on their score:
       - Score 0-2: A gentle, warm message prompting them to try again.
       - Score 3-5: A positive affirmation recognizing solid effort.
       - Score 6+: An enthusiastic and praiseful message acknowledging excellent verbal retrieval.

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
      "message": "single sentence feedback"
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
