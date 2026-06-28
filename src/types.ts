export const TestStatus = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
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

export interface TestResult extends CognitiveMetrics {
  message: string;
  timestamp: string;
  letter: string;
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
