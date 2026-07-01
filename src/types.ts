export const TestStatus = {
  WELCOME: 'WELCOME',
  MIC_REQUEST: 'MIC_REQUEST',
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  TRANSITION: 'TRANSITION',
  FINISHED: 'FINISHED',
  ERROR: 'ERROR'
} as const;
export type TestStatus = typeof TestStatus[keyof typeof TestStatus];

export interface CognitiveError {
  word: string;
  type: 'repetition' | 'wrong-letter' | 'non-animal';
}

export interface SemanticCluster {
  category: string; // e.g., 'felines', 'canines', 'marine', 'farm'
  animals: string[];
}

export interface CognitiveMetrics {
  score: number;
  animals: string[];
  clusters: SemanticCluster[];
  switchingCount: number;
  clusterSizeAverage: number;
  errors: CognitiveError[];
}

export interface WordTimestamp {
  word: string;
  time: number; // seconds from start
  iwi: number;  // interval from previous word in seconds
  isLatencySpike: boolean;
}

export interface TestResult extends CognitiveMetrics {
  message: string;
  timestamp: string;
  letter: string;
  patientId?: string;
  testDuration?: number;
  wordTimestamps?: WordTimestamp[];
  epochCounts?: number[];      // [first-third, mid-third, last-third]
  averageIwi?: number;         // average seconds between words
  lexicalRarityScore?: number; // 1-5 scale from Gemini
  switchClassifications?: { from: string; to: string; type: 'semantic' | 'phonological' | 'unrelated' }[];
}

// --- WEB SPEECH API TYPES for TypeScript ---
// These are not included in default TS DOM types, so we define them here to avoid compilation errors.

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

export interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => any) | null;
  onstart: (() => any) | null;
  onend: (() => any) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionStatic {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition: SpeechRecognitionStatic;
    webkitSpeechRecognition: SpeechRecognitionStatic;
  }
}
