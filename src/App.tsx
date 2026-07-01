import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TestStatus } from './types';
import type { TestResult, CognitiveError, SpeechRecognition, SpeechRecognitionEvent, SpeechRecognitionErrorEvent, WordTimestamp } from './types';
import { analyzeTranscript, speakWithGemini } from './services/geminiService';
import { correctWord, isValidLetterMatch, ANIMAL_DICTIONARY } from './utils/phoneticMatcher';
import { saveResult, getHistory, getHistorySummary, clearHistory, exportHistoryToCSV } from './utils/historyStore';
import { MicrophoneIcon, CheckCircleIcon, ExclamationTriangleIcon, PlayIcon, RestartIcon, BrainIcon, HistoryIcon, CogIcon, PrinterIcon, SunIcon, MoonIcon } from './components/Icons';

const DEFAULT_TEST_DURATION = 30;
const DEFAULT_LETTERS = ['L', 'S', 'B', 'C', 'M', 'T', 'W'];
// Debounce duration after timer expiry before processing results (ms)
const DEBOUNCE_MS = 500;
const NUDGE_COOLDOWN = 7000; // 7 seconds pause trigger
const DURATION_OPTIONS = [30, 60, 90, 120];

// Programmatic beep using Web Audio API
const playBeep = (frequency = 880, durationMs = 200, volume = 0.3) => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    // Quick fade-out to avoid click
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + durationMs / 1000);
    oscillator.onended = () => ctx.close();
  } catch (e) {
    console.warn('Beep failed:', e);
  }
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition: SpeechRecognition | null = SpeechRecognition ? new SpeechRecognition() : null;

if (recognition) {
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
}

const App: React.FC = () => {
  // Settings States
  const [patientId, setPatientId] = useState<string>(() => localStorage.getItem('neuroflow_patient_id') || 'Patient-1');
  const [testDuration, setTestDuration] = useState<number>(() => {
    const saved = localStorage.getItem('neuroflow_test_duration');
    return saved ? parseInt(saved, 10) : DEFAULT_TEST_DURATION;
  });
  const [letters, setLetters] = useState<string[]>(() => {
    const saved = localStorage.getItem('neuroflow_target_letters');
    try {
      return saved ? JSON.parse(saved) : DEFAULT_LETTERS;
    } catch (e) {
      return DEFAULT_LETTERS;
    }
  });
  
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [lettersInput, setLettersInput] = useState<string>(() => letters.join(', '));
  const [customApiKey, setCustomApiKey] = useState<string>(() => localStorage.getItem('neuroflow_api_key') || '');
  const [voiceCoachEnabled, setVoiceCoachEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('neuroflow_voice_coach');
    return saved === null ? true : saved === 'true';
  });
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('neuroflow_theme');
    return saved === null ? true : saved !== 'light';
  });
  const [resultsTab, setResultsTab] = useState<'patient' | 'clinical'>('patient');

  const [status, setStatus] = useState<TestStatus>(TestStatus.WELCOME);
  const [micPermissionError, setMicPermissionError] = useState<boolean>(false);
  const [selectedLetter, setSelectedLetter] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(testDuration);
  const [rawTranscript, setRawTranscript] = useState<string>("");
  const [liveAnimals, setLiveAnimals] = useState<string[]>([]);
  const [errorsObserved, setErrorsObserved] = useState<CognitiveError[]>([]);
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState<number>(0);
  const [processingStage, setProcessingStage] = useState<string>('');
  
  // Dashboard & History tab state
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historySummary, setHistorySummary] = useState(getHistorySummary());

  const timerRef = useRef<number | null>(null);
  const lastWordTimeRef = useRef<number>(Date.now());
  const hasSpokenNudgeRef = useRef<boolean>(false);
  const isNudgeSpeakingRef = useRef<boolean>(false);
  const isRecognitionActiveRef = useRef<boolean>(false);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  // Clinical tracking refs/states
  const wordTimestampsRef = useRef<WordTimestamp[]>([]);
  const testStartTimeRef = useRef<number>(0);

  // Apply theme to document root
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.remove('light-theme');
    } else {
      document.documentElement.classList.add('light-theme');
    }
  }, [isDarkMode]);

  // Cache voices changes so getVoices() is populated immediately
  useEffect(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      const handleVoicesChanged = () => {
        window.speechSynthesis.getVoices();
      };
      window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
      return () => {
        window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      };
    }
  }, []);

  // GC-proof local Web Speech fallback utility
  const speakMessageLocal = useCallback((message: string, callback?: () => void) => {
    if (!('speechSynthesis' in window)) {
      setIsSpeaking(false);
      if (callback) callback();
      return;
    }
    
    setIsSpeaking(true);
    const utterance = new SpeechSynthesisUtterance(message);
    activeUtteranceRef.current = utterance;
    
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const femaleVoice = voices.find(v => v.lang.startsWith('en-') && /female/i.test(v.name));
    if (femaleVoice) {
      utterance.voice = femaleVoice;
    }

    if (callback) {
      utterance.onend = () => {
        activeUtteranceRef.current = null;
        setIsSpeaking(false);
        callback();
      };
      utterance.onerror = (e) => {
        console.error("SpeechSynthesis error:", e);
        activeUtteranceRef.current = null;
        setIsSpeaking(false);
        callback();
      };
    } else {
      utterance.onend = () => {
        activeUtteranceRef.current = null;
        setIsSpeaking(false);
      };
      utterance.onerror = () => {
        activeUtteranceRef.current = null;
        setIsSpeaking(false);
      };
    }
    
    try {
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.error("Failed to speak message locally:", e);
      setIsSpeaking(false);
      if (callback) callback();
    }
  }, []);

  // Main voice agent entrypoint: tries LLM-based speech via Gemini first, falls back to SpeechSynthesis
  const speakMessage = useCallback((message: string, callback?: () => void) => {
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }

    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
      } catch (e) {}
      activeAudioRef.current = null;
    }

    // Respect user's mute state
    if (!voiceCoachEnabled) {
      setIsSpeaking(false);
      if (callback) callback();
      return;
    }

    setIsSpeaking(true);

    let callbackCalled = false;
    const safeCallback = () => {
      if (callbackCalled) return;
      callbackCalled = true;
      setIsSpeaking(false);
      if (callback) callback();
    };

    let safetyTimeout: number | null = null;
    if (callback) {
      safetyTimeout = window.setTimeout(() => {
        console.warn("Safety timeout fired for speakMessage callback");
        safeCallback();
      }, 10000); // 10s maximum wait
    }

    const clearSafety = () => {
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
        safetyTimeout = null;
      }
    };

    // Create and play a silent audio snippet synchronously in user gesture context to unlock subsequent audio play
    const audio = new Audio();
    audio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA";
    audio.play().catch(e => {
      console.warn("Synchronous audio play unlock failed/blocked:", e);
    });
    activeAudioRef.current = audio;

    speakWithGemini(message)
      .then(dataUrl => {
        // If another audio play was requested in the meantime, ignore this one
        if (activeAudioRef.current !== audio) return;

        audio.src = dataUrl;
        
        audio.onended = () => {
          clearSafety();
          if (activeAudioRef.current === audio) activeAudioRef.current = null;
          safeCallback();
        };
        
        audio.onerror = (err) => {
          console.error("Gemini audio playback error:", err);
          if (activeAudioRef.current === audio) activeAudioRef.current = null;
          speakMessageLocal(message, () => {
            clearSafety();
            safeCallback();
          });
        };
        
        audio.play().catch(playErr => {
          console.error("Browser play block error:", playErr);
          speakMessageLocal(message, () => {
            clearSafety();
            safeCallback();
          });
        });
      })
      .catch(err => {
        console.warn("Gemini speech failed, falling back to local TTS:", err);
        if (activeAudioRef.current === audio) activeAudioRef.current = null;
        speakMessageLocal(message, () => {
          clearSafety();
          safeCallback();
        });
      });
  }, [speakMessageLocal, voiceCoachEnabled]);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopListening = useCallback(() => {
    // Transition out of LISTENING or TRANSITION, stop recognition, timer, and move to PROCESSING
    if (status === TestStatus.LISTENING || status === TestStatus.TRANSITION) {
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {}
      }
      stopTimer();
      setStatus(TestStatus.PROCESSING);
      // Reset speaking flags so the UI can advance
      setIsSpeaking(false);
      isRecognitionActiveRef.current = false;
    }
  }, [status]);

  // Real-time voice intervention
  const triggerNudge = useCallback(() => {
    if (status !== TestStatus.LISTENING || !selectedLetter) return;
    hasSpokenNudgeRef.current = true;
    isNudgeSpeakingRef.current = true;

    // Pause recognition briefly so it doesn't transcribe the agent speaking
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {}
    }

    const prompts = [
      `You are doing great! Can you think of any other animals starting with the letter ${selectedLetter}?`,
      `Think about where they live. Are there any water or ocean animals starting with ${selectedLetter}?`,
      `How about farm or domestic animals starting with ${selectedLetter}?`,
      `Take a deep breath. Can you name any birds or insects starting with ${selectedLetter}?`
    ];
    const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];

    speakMessage(randomPrompt, () => {
      isNudgeSpeakingRef.current = false;
      // Resume recognition after speaking finishes
      if (status === TestStatus.LISTENING && recognition && !isRecognitionActiveRef.current) {
        try {
          recognition.start();
        } catch (e) {
          console.error("Failed to restart recognition:", e);
        }
      }
    });

    // Reset last word time to give the user time to answer
    lastWordTimeRef.current = Date.now();
  }, [status, selectedLetter, speakMessage]);

  const calculateEpochCounts = (timestamps: WordTimestamp[], duration: number): number[] => {
    const third = duration / 3;
    let first = 0;
    let second = 0;
    let last = 0;
    timestamps.forEach(t => {
      if (t.time <= third) {
        first++;
      } else if (t.time <= third * 2) {
        second++;
      } else {
        last++;
      }
    });
    return [first, second, last];
  };

  const calculateAverageIwi = (timestamps: WordTimestamp[]): number => {
    if (timestamps.length === 0) return 0;
    const sum = timestamps.reduce((acc, t) => acc + t.iwi, 0);
    return Math.round((sum / timestamps.length) * 100) / 100;
  };

  const processResult = useCallback(async () => {
    if (!rawTranscript || !selectedLetter) {
      setProcessingProgress(100);
      setProcessingStage('Complete');
      const emptyResult: TestResult = {
        score: 0,
        animals: [],
        clusters: [],
        switchingCount: 0,
        clusterSizeAverage: 0,
        errors: errorsObserved,
        message: "It seems we didn't catch anything. Let's try again!",
        timestamp: new Date().toISOString(),
        letter: selectedLetter || 'L',
        patientId: patientId,
        testDuration: testDuration,
        wordTimestamps: wordTimestampsRef.current,
        epochCounts: [0, 0, 0],
        averageIwi: 0
      };
      setResult(emptyResult);
      saveResult(emptyResult);
      setHistorySummary(getHistorySummary());
      setStatus(TestStatus.FINISHED);
      return;
    }

    try {
      setProcessingProgress(15);
      setProcessingStage('Finalizing audio capture');
      await new Promise(r => setTimeout(r, 300));

      setProcessingProgress(30);
      setProcessingStage('Analyzing transcript with Gemini');
      const analysis = await analyzeTranscript(rawTranscript, selectedLetter, errorsObserved, testDuration);
      
      setProcessingProgress(65);
      setProcessingStage('Building semantic clusters');
      await new Promise(r => setTimeout(r, 250));

      const stamps = wordTimestampsRef.current;
      const epochCounts = calculateEpochCounts(stamps, testDuration);
      const averageIwi = calculateAverageIwi(stamps);

      setProcessingProgress(85);
      setProcessingStage('Computing cognitive metrics');
      await new Promise(r => setTimeout(r, 200));

      const finalResult: TestResult = {
        ...analysis,
        timestamp: new Date().toISOString(),
        letter: selectedLetter,
        patientId: patientId,
        testDuration: testDuration,
        wordTimestamps: stamps,
        epochCounts: epochCounts,
        averageIwi: averageIwi
      };

      setProcessingProgress(95);
      setProcessingStage('Generating clinical report');
      await new Promise(r => setTimeout(r, 200));

      setResult(finalResult);
      saveResult(finalResult);
      setHistorySummary(getHistorySummary());

      setProcessingProgress(100);
      setProcessingStage('Complete');
      await new Promise(r => setTimeout(r, 150));

      setStatus(TestStatus.FINISHED);
    } catch (e) {
      console.error(e);
      setErrorMsg("Sorry, I had trouble analyzing the results. Please try again.");
      setStatus(TestStatus.FINISHED);
    }
  }, [rawTranscript, selectedLetter, errorsObserved, testDuration, patientId]);

  const addWordToTest = useCallback((word: string) => {
    const corrected = correctWord(word, selectedLetter || 'L');
    if (!corrected) return;

    const elapsed = (Date.now() - testStartTimeRef.current) / 1000;
    const lastEntry = wordTimestampsRef.current[wordTimestampsRef.current.length - 1];
    let merged = false;
    
    // Try compound word merging
    const dict = ANIMAL_DICTIONARY[selectedLetter || 'L'] || [];
    if (lastEntry && (elapsed - lastEntry.time) < 2.5) {
      const potentialCompound = `${lastEntry.word} ${corrected}`.toLowerCase();
      if (dict.some((anim: string) => anim.toLowerCase() === potentialCompound)) {
        // Remove the previous single word from liveAnimals
        setLiveAnimals(prev => prev.filter(a => a.toLowerCase() !== lastEntry.word.toLowerCase()));
        const oldWord = lastEntry.word;
        lastEntry.word = potentialCompound;
        
        // If it is already in liveAnimals (repetition), log error, else add
        setLiveAnimals(prev => {
          if (prev.includes(potentialCompound)) {
            setErrorsObserved(errs => [
              ...errs.filter(e => e.word.toLowerCase() !== oldWord.toLowerCase()),
              { word: potentialCompound, type: 'repetition' }
            ]);
            return prev;
          } else {
            lastWordTimeRef.current = Date.now();
            return [...prev, potentialCompound];
          }
        });
        
        // Remove wrong-letter error of first word if it was there
        setErrorsObserved(errs => errs.filter(e => e.word.toLowerCase() !== oldWord.toLowerCase()));
        merged = true;
      }
    }
    
    if (!merged) {
      // Handle single word validation
      if (isValidLetterMatch(corrected, selectedLetter || 'L')) {
        setLiveAnimals(prev => {
          if (prev.includes(corrected)) {
            // Pre-log repetition error
            setErrorsObserved(errs => [...errs, { word: corrected, type: 'repetition' }]);
          } else {
            // Unique correct word found! Update timer and list
            lastWordTimeRef.current = Date.now();
            prev = [...prev, corrected];
          }
          return prev;
        });
      } else {
        // Wrong starting letter
        setErrorsObserved(errs => [...errs, { word: corrected, type: 'wrong-letter' }]);
      }
      
      // Log to timestamps
      const prevTime = wordTimestampsRef.current.length > 0
        ? wordTimestampsRef.current[wordTimestampsRef.current.length - 1].time
        : 0;
      const iwi = elapsed - prevTime;
      const isLatencySpike = iwi > 4.0;
      const newTimestamp: WordTimestamp = {
        word: corrected,
        time: Math.round(elapsed * 10) / 10,
        iwi: Math.round(iwi * 10) / 10,
        isLatencySpike
      };
      wordTimestampsRef.current.push(newTimestamp);
    }
  }, [selectedLetter]);

  useEffect(() => {
    if (!recognition) {
      if (status !== TestStatus.ERROR) {
        setErrorMsg("Speech recognition is not supported by your browser. Please use Chrome or Edge.");
        setStatus(TestStatus.ERROR);
      }
      return;
    }

    recognition.onstart = () => {
      isRecognitionActiveRef.current = true;
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
        // Only process results while actively listening
        if (status !== TestStatus.LISTENING) return;
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript + ' ';
          }
        }
      
      if (finalTranscript) {
        setRawTranscript(prev => prev + finalTranscript);

        // Extract individual words for real-time validation and active coaching
        const words = finalTranscript.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").split(/\s+/).filter(Boolean);
        words.forEach(word => {
          addWordToTest(word);
        });
      }
    };
    
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Ignore 'no-speech' or temporary aborts, handle hard errors
      if (event.error === 'no-speech') return;
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        setErrorMsg("Microphone blocked. Please ensure microphone access is allowed in your browser settings and try again.");
        setStatus(TestStatus.ERROR);
        stopTimer();
        return;
      }
      setErrorMsg(`Speech recognition error: ${event.error}. Please ensure microphone access is allowed.`);
      setStatus(TestStatus.ERROR);
      stopTimer();
    };

    recognition.onend = () => {
        isRecognitionActiveRef.current = false;
        // Restart recognition only if we are still actively listening
        if (status === TestStatus.LISTENING && !isNudgeSpeakingRef.current && !isRecognitionActiveRef.current) {
          try {
            recognition.start();
          } catch (e) {
            console.error('Failed to restart recognition onend:', e);
          }
        }
      };
  }, [status, selectedLetter, addWordToTest, speakMessage]);

  // Voice feedback when selecting a letter
  useEffect(() => {
    if (selectedLetter && status === TestStatus.IDLE) {
      speakMessage(`You have chosen to name animals starting with the letter ${selectedLetter}.`);
    }
  }, [selectedLetter, status, speakMessage]);

  const handleBeginWelcome = () => {
    if (isSpeaking) {
      // If clicked again while speaking, skip to setup immediately
      if ('speechSynthesis' in window) {
        try { window.speechSynthesis.cancel(); } catch (e) {}
      }
      if (activeAudioRef.current) {
        try { activeAudioRef.current.pause(); } catch (e) {}
        activeAudioRef.current = null;
      }
      setIsSpeaking(false);
      setStatus(TestStatus.MIC_REQUEST);
      return;
    }

    const welcomeAnnouncement = 
      `Welcome to the NeuroFlow Cognitive Trainer. This assessment measures verbal fluency by having you name as many animals as you can starting with a designated letter in ${testDuration} seconds. First, we will guide you through granting microphone permissions so we can capture and analyze your voice.`;
    speakMessage(welcomeAnnouncement, () => {
      setStatus(TestStatus.MIC_REQUEST);
    });
  };

  const requestMicrophonePermission = () => {
    speakMessage("Please click allow on your browser's microphone permission prompt.");
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach(track => track.stop());
          setMicPermissionError(false);
          setStatus(TestStatus.IDLE);
          speakMessage("Microphone access granted. Please select a letter to start the test.");
        })
        .catch((err) => {
          console.warn("Microphone access denied: ", err);
          setMicPermissionError(true);
          speakMessage("Microphone access was denied. Please allow microphone access in your browser settings and try again.");
        });
    } else {
      setMicPermissionError(true);
      speakMessage("Microphone is not supported by your browser.");
    }
  };




  useEffect(() => {
    if (status === TestStatus.PROCESSING) {
      processResult();
    }
  }, [status, processResult]);

  // Ensure transition state progresses to processing
  useEffect(() => {
    if (status === TestStatus.TRANSITION) {
      // Directly invoke stopListening to move to PROCESSING
      stopListening();
    }
  }, [status, stopListening]);

  useEffect(() => {
    if (status === TestStatus.FINISHED && result?.message) {
      // Speak the coach feedback only when voice feedback is enabled
      if (voiceCoachEnabled) {
        speakMessage(result.message);
      }
    }
  }, [status, result, speakMessage]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      if (recognition) recognition.abort();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (activeAudioRef.current) {
        try {
          activeAudioRef.current.pause();
        } catch (e) {}
      }
      // Ensure any lingering speaking state is cleared
      setIsSpeaking(false);
      stopTimer();
    };
  }, []);

  // Reset speaking flag when the component re‑mounts (e.g., after a new test starts)
  useEffect(() => {
    setIsSpeaking(false);
  }, []);


  const startTest = () => {
    if (!selectedLetter) return;
    setErrorMsg(null);
    setResult(null);
    setRawTranscript("");
    setLiveAnimals([]);
    setErrorsObserved([]);
    setProcessingProgress(0);
    setProcessingStage('');
    setTimeLeft(testDuration);
    setStatus(TestStatus.LISTENING);
    // Play start beep
    playBeep(880, 200, 0.3);
    lastWordTimeRef.current = Date.now();
    hasSpokenNudgeRef.current = false;
    isNudgeSpeakingRef.current = false;
    
    // Clear timestamps & record start time
    wordTimestampsRef.current = [];
    testStartTimeRef.current = Date.now();
    
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recognition && !isRecognitionActiveRef.current) {
        recognition.start();
      }
    } catch(e) {
      console.error("Error starting recognition: ", e);
      setStatus(TestStatus.IDLE);
    }

    timerRef.current = window.setInterval(() => {
        // Run nudge check
        const elapsedSinceLastWord = Date.now() - lastWordTimeRef.current;
        if (
          voiceCoachEnabled &&
          !hasSpokenNudgeRef.current &&
          !isNudgeSpeakingRef.current &&
          elapsedSinceLastWord > NUDGE_COOLDOWN
        ) {
          triggerNudge();
        }

        setTimeLeft(prev => {
          if (prev <= 1) {
            // Timer expired – play end beep, stop timer, debounce, then transition
            playBeep(660, 350, 0.35);
            stopTimer();
            // Show brief transition screen before processing
            setStatus(TestStatus.TRANSITION);
            // Debounce to lock out any stray audio input
            setTimeout(() => {
              stopListening(); // will move to PROCESSING
            }, DEBOUNCE_MS);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
  };
  
  const resetTest = () => {
    stopTimer();
    if (recognition && status === TestStatus.LISTENING) {
      recognition.stop();
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
      } catch (e) {}
      activeAudioRef.current = null;
    }
    setStatus(TestStatus.IDLE);
    setSelectedLetter(null);
    setRawTranscript("");
    setLiveAnimals([]);
    setErrorsObserved([]);
    setResult(null);
    setErrorMsg(null);
    setTimeLeft(testDuration);
    wordTimestampsRef.current = [];
  };

  const progress = ((testDuration - timeLeft) / testDuration) * 100;

  const renderContent = () => {
    switch (status) {
      case TestStatus.WELCOME:
        const hasApiKey = !!customApiKey || !!import.meta.env.VITE_GEMINI_API_KEY || (typeof process !== 'undefined' && process.env && (process.env.API_KEY || process.env.GEMINI_API_KEY));
        return (
          <div className="text-center py-6">
            <div className="flex justify-center mb-6">
              <div className="p-4 rounded-full animate-bounce" style={{ background: 'rgba(6, 182, 212, 0.1)', boxShadow: '0 0 40px rgba(6, 182, 212, 0.2), 0 0 80px rgba(139, 92, 246, 0.1)' }}>
                <BrainIcon className="h-14 w-14 text-cyan-400 icon-glow" />
              </div>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">
              Welcome to <span className="gradient-text">NeuroFlow</span>
            </h1>
            <p className="text-white/50 max-w-md mx-auto mt-3 mb-8">
              A cognitive verbal fluency trainer. You will name as many animals as you can starting with a designated letter in {testDuration} seconds.
            </p>

            {!hasApiKey && (
              <div className="mb-8 max-w-md mx-auto p-4 glass rounded-2xl text-left flex gap-3" style={{ borderColor: 'rgba(245, 158, 11, 0.3)' }}>
                <ExclamationTriangleIcon className="h-5 w-5 shrink-0 mt-0.5 text-amber-400" />
                <div className="text-xs">
                  <p className="font-bold text-amber-400">Gemini API Key is not configured</p>
                  <p className="mt-0.5 leading-relaxed text-white/40">
                    Voice agent synthesis and clinical diagnostic analysis require a Gemini API Key. Click the gear icon in the top-right to enter your key.
                  </p>
                </div>
              </div>
            )}

            <button
              onClick={handleBeginWelcome}
              className="btn-gradient font-bold py-3.5 px-8 rounded-xl"
            >
              {isSpeaking ? 'Skip Introduction' : 'Begin Assessment'}
            </button>
          </div>
        );

      case TestStatus.MIC_REQUEST:
        return (
          <div className="text-center py-6">
            <div className="flex justify-center mb-6">
              <div className="p-4 rounded-full pulse-ring" style={{ background: 'rgba(6, 182, 212, 0.1)' }}>
                <MicrophoneIcon className="h-14 w-14 text-cyan-400 icon-glow animate-pulse" />
              </div>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Microphone Setup
            </h1>
            <p className="text-white/50 max-w-md mx-auto mt-2 mb-8">
              We need permission to access your microphone to transcribe and analyze your responses in real time.
            </p>
            {micPermissionError && (
              <p className="text-red-400 text-sm font-semibold mb-4">
                Microphone access was denied. Please allow it in your browser settings and try again.
              </p>
            )}
            <button
              onClick={requestMicrophonePermission}
              className="btn-gradient font-bold py-3.5 px-8 rounded-xl"
            >
              Grant Microphone Access
            </button>
          </div>
        );
      case TestStatus.LISTENING:
        return (
          <div className="flex flex-col items-center justify-center text-center">
            <div className="relative w-52 h-52 flex items-center justify-center">
              <svg className="absolute w-full h-full transform -rotate-90" viewBox="0 0 224 224" style={{ filter: 'drop-shadow(0 0 8px rgba(6, 182, 212, 0.4))' }}>
                <circle style={{ stroke: 'rgba(255,255,255,0.06)' }} strokeWidth="12" fill="transparent" r="100" cx="112" cy="112" />
                <circle
                  className="text-cyan-400 transition-all duration-300"
                  strokeWidth="12"
                  strokeDasharray={2 * Math.PI * 100}
                  strokeDashoffset={(2 * Math.PI * 100) * (1 - progress / 100)}
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="transparent"
                  r="100"
                  cx="112"
                  cy="112"
                />
              </svg>
              <div className="flex flex-col items-center">
                 <MicrophoneIcon className="h-16 w-16 mb-2 text-cyan-400 icon-glow animate-pulse" />
                 <span className="text-5xl font-extrabold font-sans tracking-tight text-white">{timeLeft}</span>
              </div>
            </div>
            <p className="mt-8 text-lg font-medium text-white/80">Name animals starting with '<span className="text-cyan-400 font-bold">{selectedLetter}</span>'...</p>
            
            {/* Live transcribing feedback */}
            <div className="mt-6 w-full max-w-md glass-card rounded-xl p-4">
              <div className="flex justify-between items-center mb-2 pb-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span className="text-xs font-semibold text-white/40 uppercase tracking-wider">Identified Animals ({liveAnimals.length})</span>
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto">
                {liveAnimals.length > 0 ? (
                  liveAnimals.map((animal, idx) => (
                    <span key={idx} className="px-2.5 py-1 chip-green text-xs font-semibold rounded-full capitalize">
                      {animal}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-white/30 italic">Listening for animal names...</span>
                )}
              </div>
            </div>
          </div>
        );

      case TestStatus.PROCESSING:
      case TestStatus.TRANSITION:
        {
          const pct = status === TestStatus.TRANSITION ? 5 : processingProgress;
          const stage = status === TestStatus.TRANSITION ? 'Finalizing audio capture' : processingStage;
          return (
            <div className="flex flex-col items-center justify-center text-center py-10 w-full max-w-md mx-auto">
              <BrainIcon className="h-12 w-12 text-cyan-400 icon-glow mb-6 animate-pulse" />
              <p className="text-xl font-semibold text-white mb-2">Analyzing Results</p>
              <p className="text-sm text-white/40 mb-8">{stage || 'Preparing analysis...'}</p>

              {/* Glass Progress Bar */}
              <div className="w-full">
                <div className="relative w-full h-7 rounded-xl overflow-hidden progress-bar-track">
                  <div
                    className="absolute inset-y-0 left-0 rounded-xl transition-all duration-500 ease-out progress-bar-fill"
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  >
                  </div>
                </div>
                <div className="flex justify-between items-center mt-2.5">
                  <span className="text-xs font-bold text-cyan-400">{pct}%</span>
                  <span className="text-[10px] text-white/30 font-medium">Processing clinical data</span>
                </div>
              </div>
            </div>
          );
        }

      case TestStatus.FINISHED:
        {
          const semCount = result?.switchClassifications?.filter(s => s.type === 'semantic').length || 0;
          const phonCount = result?.switchClassifications?.filter(s => s.type === 'phonological').length || 0;
          const unrelCount = result?.switchClassifications?.filter(s => s.type === 'unrelated').length || 0;

          return (
            <div className="w-full">
              {/* Header */}
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold flex items-center text-white">
                  <CheckCircleIcon className="h-7 w-7 text-emerald-400 mr-2.5" style={{ filter: 'drop-shadow(0 0 6px rgba(16,185,129,0.5))' }}/> Test Results
                </h2>
                <span className="text-xs font-medium chip-blue px-3 py-1.5 rounded-full font-mono">
                  Letter: {result?.letter}
                </span>
              </div>

              {/* Tab Selector */}
              <div className="flex mb-6" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <button
                  onClick={() => setResultsTab('patient')}
                  className={`py-2.5 px-5 text-sm font-bold border-b-2 transition-colors ${
                    resultsTab === 'patient'
                      ? 'border-cyan-400 text-cyan-400'
                      : 'border-transparent text-white/40 hover:text-white/70'
                  }`}
                >
                  Patient View
                </button>
                <button
                  onClick={() => setResultsTab('clinical')}
                  className={`py-2.5 px-5 text-sm font-bold border-b-2 transition-colors ${
                    resultsTab === 'clinical'
                      ? 'border-cyan-400 text-cyan-400'
                      : 'border-transparent text-white/40 hover:text-white/70'
                  }`}
                >
                  Clinical Insights
                </button>
              </div>

              {resultsTab === 'patient' ? (
                /* Patient View Tab */
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Big Score Card */}
                    <div className="score-card rounded-2xl p-6 text-white flex flex-col items-center justify-center">
                      <span className="text-xs font-bold uppercase tracking-wider text-white/70 mb-2">Fluency Score</span>
                      <span className="text-7xl font-extrabold leading-none">{result?.score}</span>
                      <span className="text-sm font-medium text-white/70 mt-3 text-center">valid unique animals</span>
                    </div>

                    {/* Coach Feedback */}
                    <div className="md:col-span-2 space-y-4">
                      <div className="glass-card rounded-2xl p-5">
                        <span className="text-xs font-bold uppercase tracking-wider text-white/40">Coach Feedback</span>
                        <p className="mt-2 text-white/80 font-medium leading-relaxed">{result?.message}</p>
                      </div>

                      {/* Sub-metrics */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="glass rounded-xl p-4">
                          <span className="text-xs font-bold uppercase tracking-wider text-white/40">Switching Speed</span>
                          <p className="text-2xl font-extrabold text-white mt-1">{result?.switchingCount}</p>
                          <span className="text-[10px] text-white/30">category transitions</span>
                        </div>
                        <div className="glass rounded-xl p-4">
                          <span className="text-xs font-bold uppercase tracking-wider text-white/40">Avg Cluster Size</span>
                          <p className="text-2xl font-extrabold text-white mt-1">{result?.clusterSizeAverage}</p>
                          <span className="text-[10px] text-white/30 font-medium">animals per group</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Semantic Clusters Section */}
                  <div className="glass-card rounded-2xl p-5">
                    <span className="text-xs font-bold uppercase tracking-wider text-white/40 block mb-3">Semantic Categories Used</span>
                    <div className="flex flex-wrap gap-4">
                      {result?.clusters && result.clusters.length > 0 ? (
                        result.clusters.map((cluster, i) => (
                          <div key={i} className="flex-1 min-w-[200px] glass-inner rounded-xl p-3.5">
                            <span className="text-xs font-bold text-cyan-400 capitalize">{cluster.category}</span>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {cluster.animals.map((anim, idx) => (
                                <span key={idx} className="px-2 py-0.5 text-white/60 text-[10px] font-medium rounded-md capitalize" style={{ background: 'rgba(255,255,255,0.06)' }}>
                                  {anim}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))
                      ) : (
                        <span className="text-sm text-white/30 italic">No semantic groups identified.</span>
                      )}
                    </div>
                  </div>

                  {/* Errors Card */}
                  {result?.errors && result.errors.length > 0 && (
                    <div className="glass rounded-2xl p-5" style={{ borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                      <span className="text-xs font-bold uppercase tracking-wider text-red-400 block mb-2">Speech Errors & Repetitions</span>
                      <div className="flex flex-wrap gap-2">
                        {result.errors.map((err, i) => (
                          <span key={i} className="px-2.5 py-1 chip-red text-[10px] font-semibold rounded-md capitalize">
                            {err.word} <span className="opacity-60 text-[8px] font-medium">({err.type})</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* Clinical Insights Tab */
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Decay Curve */}
                    <div className="glass-card rounded-2xl p-5 flex flex-col justify-between">
                      <div>
                        <span className="text-xs font-bold uppercase tracking-wider text-white/40">Retrieval Decay Curve</span>
                        {(() => {
                          const epochs = result?.epochCounts || [0, 0, 0];
                          const maxVal = Math.max(...epochs, 1);
                          const chartW = 220;
                          const chartH = 120;
                          const padL = 30;
                          const padR = 15;
                          const padT = 15;
                          const padB = 25;
                          const plotW = chartW - padL - padR;
                          const plotH = chartH - padT - padB;
                          const points = epochs.map((val, i) => ({
                            x: padL + (i / (epochs.length - 1)) * plotW,
                            y: padT + plotH - (val / maxVal) * plotH,
                            val
                          }));
                          const linePoints = points.map(p => `${p.x},${p.y}`).join(' ');
                          const areaPoints = `${padL},${padT + plotH} ${linePoints} ${padL + plotW},${padT + plotH}`;
                          const yTicks = [0, Math.round(maxVal / 2), maxVal];

                          return (
                            <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full mt-3" style={{ maxHeight: '160px' }}>
                              <defs>
                                <linearGradient id="decayFill" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.35" />
                                  <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.03" />
                                </linearGradient>
                              </defs>
                              {yTicks.map((tick, i) => {
                                const yPos = padT + plotH - (tick / maxVal) * plotH;
                                return (
                                  <g key={`ytick-${i}`}>
                                    <line x1={padL} y1={yPos} x2={padL + plotW} y2={yPos} stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" strokeDasharray="3,3" />
                                    <text x={padL - 4} y={yPos + 3} textAnchor="end" fontSize="7" fill="rgba(255,255,255,0.4)" fontWeight="600">{tick}</text>
                                  </g>
                                );
                              })}
                              <polygon points={areaPoints} fill="url(#decayFill)" />
                              <polyline points={linePoints} fill="none" stroke="#06b6d4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(6,182,212,0.5))' }} />
                              {points.map((p, i) => (
                                <g key={`pt-${i}`}>
                                  <circle cx={p.x} cy={p.y} r="4" fill="#06b6d4" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
                                  <text x={p.x} y={p.y - 8} textAnchor="middle" fontSize="8" fontWeight="700" fill="rgba(255,255,255,0.8)">{p.val}</text>
                                </g>
                              ))}
                              {epochs.map((_, i) => {
                                const third = Math.round((result?.testDuration || testDuration) / 3);
                                const from = third * i;
                                const to = i === 2 ? (result?.testDuration || testDuration) : third * (i + 1);
                                const label = `${from}\u2013${to}s`;
                                const xPos = padL + (i / (epochs.length - 1)) * plotW;
                                return (
                                  <text key={`xlabel-${i}`} x={xPos} y={chartH - 5} textAnchor="middle" fontSize="7" fill="rgba(255,255,255,0.35)" fontWeight="600">{label}</text>
                                );
                              })}
                              <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                              <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                            </svg>
                          );
                        })()}
                      </div>
                      <p className="text-[10px] text-white/30 mt-3 leading-relaxed">
                        Prefrontal search decays over time. Normal curves show decay as semantic pools exhaust.
                      </p>
                    </div>

                    {/* Lexical Rarity Meter */}
                    <div className="glass-card rounded-2xl p-5 flex flex-col justify-between">
                      <div>
                        <span className="text-xs font-bold uppercase tracking-wider text-white/40">Lexical Rarity Index</span>
                        <div className="flex items-baseline mt-4">
                          <span className="text-4xl font-extrabold text-white">{result?.lexicalRarityScore || 'N/A'}</span>
                          <span className="text-sm text-white/40 font-semibold ml-1">/ 5.0</span>
                        </div>
                      </div>
                      <div className="mt-4">
                        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <div
                            style={{ width: `${((result?.lexicalRarityScore || 1) / 5) * 100}%`, background: 'linear-gradient(90deg, #06b6d4, #8b5cf6)' }}
                            className="h-full rounded-full"
                          ></div>
                        </div>
                        <div className="flex justify-between text-[8px] text-white/30 mt-1 font-medium">
                          <span>Common (1.0)</span>
                          <span>Exotic (5.0)</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-white/30 mt-3 leading-relaxed">
                        Evaluates vocabulary density and cognitive reserve from basic to advanced animal terms.
                      </p>
                    </div>

                    {/* Cognitive Shifting Strategy */}
                    <div className="glass-card rounded-2xl p-5 flex flex-col justify-between">
                      <div>
                        <span className="text-xs font-bold uppercase tracking-wider text-white/40 block mb-2">Shifting Strategy</span>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="glass-inner py-1.5 rounded-lg">
                            <span className="text-[9px] font-semibold text-emerald-400 uppercase">Sem</span>
                            <p className="text-lg font-bold text-white">{semCount}</p>
                          </div>
                          <div className="glass-inner py-1.5 rounded-lg">
                            <span className="text-[9px] font-semibold text-cyan-400 uppercase">Phon</span>
                            <p className="text-lg font-bold text-white">{phonCount}</p>
                          </div>
                          <div className="glass-inner py-1.5 rounded-lg">
                            <span className="text-[9px] font-semibold text-amber-400 uppercase">Unrel</span>
                            <p className="text-lg font-bold text-white">{unrelCount}</p>
                          </div>
                        </div>
                      </div>
                      <p className="text-[10px] text-white/30 mt-3 leading-relaxed">
                        Semantic (habitat/family shift), Phonological (sound-driven shift), or Unrelated (stochastic shift).
                      </p>
                    </div>
                  </div>

                  {/* Chronological Spoken Timeline */}
                  <div className="glass-card rounded-2xl p-5">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-white/40">Spoken Word Timeline</span>
                      <span className="text-xs text-white/40">Avg IWI: <span className="font-bold text-white/80">{result?.averageIwi || 'N/A'}s</span></span>
                    </div>
                    <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                      {result?.wordTimestamps && result.wordTimestamps.length > 0 ? (
                        result.wordTimestamps.map((item, idx) => (
                          <div key={idx} className="flex justify-between items-center glass-inner p-2.5 rounded-xl">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-extrabold text-white/40 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.06)' }}>{idx + 1}</span>
                              <span className="text-sm font-bold text-white capitalize">{item.word}</span>
                            </div>
                            <div className="flex items-center gap-2.5">
                              <span className="text-xs font-semibold text-white/50 font-mono">+{item.time}s</span>
                              <span className="text-[10px] text-white/30 font-mono">(IWI: {item.iwi}s)</span>
                              {item.isLatencySpike && (
                                <span className="px-2 py-0.5 chip-red font-bold text-[9px] rounded-md">
                                  Latency Spike (&gt;4s)
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-sm text-white/30 italic py-4 text-center">No words logged.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex justify-center gap-4 mt-8">
                <button
                  onClick={resetTest}
                  className="btn-gradient font-bold py-3 px-6 rounded-xl flex items-center justify-center"
                >
                  <RestartIcon className="h-5 w-5 mr-2" />
                  Practice Again
                </button>
                <button
                  onClick={() => window.print()}
                  className="btn-glass font-bold py-3 px-6 rounded-xl flex items-center justify-center"
                >
                  <PrinterIcon className="h-5 w-5 mr-2 text-white/50" />
                  Print Report
                </button>
              </div>
            </div>
          );
        }

      case TestStatus.ERROR:
        return (
          <div className="text-center flex flex-col items-center py-6">
            <ExclamationTriangleIcon className="h-14 w-14 text-red-400 mb-4" style={{ filter: 'drop-shadow(0 0 8px rgba(239,68,68,0.5))' }}/>
            <h2 className="text-2xl font-bold text-red-400">An Error Occurred</h2>
            <p className="mt-2 text-white/50 max-w-sm">{errorMsg}</p>
            <button
              onClick={resetTest}
              className="mt-8 btn-gradient font-bold py-3 px-6 rounded-xl flex items-center justify-center mx-auto"
            >
              <RestartIcon className="h-5 w-5 mr-2" />
              Try Again
            </button>
          </div>
        );

      case TestStatus.IDLE:
      default:
        return (
          <div className="text-center">
            <div className="flex justify-center mb-3">
              <div className="p-3 rounded-2xl" style={{ background: 'rgba(6, 182, 212, 0.08)' }}>
                <BrainIcon className="h-10 w-10 text-cyan-400 icon-glow" />
              </div>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">NeuroFlow <span className="gradient-text">Cognitive Trainer</span></h1>
            <p className="text-sm text-white/40 max-w-md mx-auto mt-1 mb-8">Evolving verbal fluency practice with active speech interventions and cognitive semantic maps.</p>
            
            {!selectedLetter ? (
               <>
                <p className="text-base font-semibold text-white/70 mb-4">Select a letter to begin the evaluation:</p>
                <div className="flex flex-wrap justify-center gap-3.5 max-w-md mx-auto">
                    {letters.map(letter => (
                        <button 
                            key={letter}
                            onClick={() => setSelectedLetter(letter)}
                            className="w-14 h-14 text-xl font-bold rounded-xl transition-all transform focus:outline-none letter-btn"
                        >
                            {letter}
                        </button>
                    ))}
                </div>
               </>
            ) : (
                <>
                <p className="text-white/50 mb-6">You will name as many animals as you can that start with the letter:</p>
                <div className="flex flex-wrap justify-center gap-3.5 max-w-md mx-auto mb-8">
                     {letters.map(letter => (
                        <button 
                            key={letter}
                            onClick={() => setSelectedLetter(letter)}
                            className={`w-14 h-14 text-xl font-bold rounded-xl transition-all transform focus:outline-none
                                ${selectedLetter === letter 
                                    ? 'letter-btn-active'
                                    : 'letter-btn'
                                }`}
                        >
                            {letter}
                        </button>
                     ))}
                </div>
                
                <div className="flex gap-4 max-w-md mx-auto">
                  <button
                    onClick={() => setSelectedLetter(null)}
                    className="flex-1 btn-glass font-bold py-3.5 px-6 rounded-xl"
                  >
                    Back
                  </button>
                  <button
                    onClick={startTest}
                    className="flex-2 btn-gradient font-bold py-3.5 px-8 rounded-xl flex items-center justify-center"
                  >
                    <PlayIcon className="h-5 w-5 mr-2" />
                    Start Evaluation
                  </button>
                </div>
                </>
            )}
          </div>
        );
    }
  };

  const renderHistorySummary = () => {
    return (
      <div className="w-full">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold flex items-center text-white">
            <HistoryIcon className="h-6 w-6 text-cyan-400 icon-glow mr-2.5"/> Practice History
          </h2>
          <button
            onClick={() => {
              clearHistory();
              setHistorySummary(getHistorySummary());
            }}
            className="text-xs font-semibold text-red-400 hover:text-red-300 transition-colors"
          >
            Clear History
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="glass-card rounded-2xl p-5 text-center">
            <span className="text-xs font-bold uppercase tracking-wider text-white/40">Total Evaluations</span>
            <p className="text-4xl font-extrabold text-white mt-1">{historySummary.totalTests}</p>
          </div>
          <div className="glass-card rounded-2xl p-5 text-center">
            <span className="text-xs font-bold uppercase tracking-wider text-white/40">Average Score</span>
            <p className="text-4xl font-extrabold text-white mt-1">{historySummary.averageScore}</p>
          </div>
          <div className="glass-card rounded-2xl p-5 text-center">
            <span className="text-xs font-bold uppercase tracking-wider text-white/40">Personal Best</span>
            <p className="text-4xl font-extrabold text-white mt-1">{historySummary.bestScore}</p>
          </div>
        </div>

        {/* Breakdown by letter */}
        <div className="mb-6 glass-card rounded-2xl p-5">
          <span className="text-xs font-bold uppercase tracking-wider text-white/40 block mb-3">Score Breakdown by Letter</span>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3">
            {letters.map(letter => {
              const info = historySummary.byLetter[letter.toUpperCase()] || { count: 0, avgScore: 0 };
              return (
                <div key={letter} className="glass-inner rounded-xl p-3 text-center">
                  <span className="text-sm font-bold text-cyan-400">{letter}</span>
                  <p className="text-lg font-extrabold text-white">{info.avgScore}</p>
                  <span className="text-[8px] text-white/30">({info.count} tests)</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* History table list */}
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-xs font-bold uppercase tracking-wider text-white/40">Evaluation Log</span>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {getHistory().slice().reverse().map((item, idx) => {
              const dateObj = new Date(item.timestamp);
              return (
                <div key={idx} className="px-5 py-3 flex justify-between items-center" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div>
                    <span className="text-sm font-bold text-white">Letter: {item.letter}</span>
                    <p className="text-[8px] text-white/30">{dateObj.toLocaleDateString()} {dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-extrabold text-white">Score: {item.score}</span>
                    <p className="text-[8px] text-white/30">{item.switchingCount} switches</p>
                  </div>
                </div>
              );
            })}
            {historySummary.totalTests === 0 && (
              <div className="px-5 py-6 text-center text-sm text-white/30 italic">No past tests logged yet.</div>
            )}
          </div>
        </div>

        <button
          onClick={() => setShowHistory(false)}
          className="mt-8 btn-glass font-bold py-3.5 px-7 rounded-xl flex items-center justify-center mx-auto"
        >
          Back to Evaluation
        </button>
      </div>
    );
  };

  const isTesting = status === TestStatus.LISTENING || status === TestStatus.PROCESSING;
  const isWideLayout = status === TestStatus.FINISHED || showHistory;

  return (
    <>
      {/* Aurora animated background */}
      <div className="aurora-bg">
        <div className="aurora-orb"></div>
      </div>

      <div className="min-h-screen text-white flex flex-col p-4 relative z-10 print:hidden">
        {/* Top Navbar */}
        <header className={`w-full mx-auto flex justify-between items-center py-4 ${isWideLayout ? 'max-w-4xl' : 'max-w-2xl'}`}>
          <span className="text-base font-extrabold tracking-tight gradient-text flex items-center">
            <BrainIcon className="h-5 w-5 text-cyan-400 icon-glow mr-1.5" /> NeuroFlow AI
            {isSpeaking && (
              <span className="flex items-end gap-[3px] ml-2.5 h-3.5 pb-[2px]" title="Voice agent is speaking">
                <span className="w-[3px] bg-cyan-400 h-full rounded-full animate-soundwave-1"></span>
                <span className="w-[3px] bg-cyan-400 h-full rounded-full animate-soundwave-2"></span>
                <span className="w-[3px] bg-cyan-400 h-full rounded-full animate-soundwave-3"></span>
                <span className="w-[3px] bg-cyan-400 h-full rounded-full animate-soundwave-4"></span>
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            {status === TestStatus.IDLE && (
              <button
                onClick={() => {
                  setShowHistory(prev => !prev);
                  setHistorySummary(getHistorySummary());
                }}
                className="flex items-center text-xs font-semibold px-3 py-2 btn-glass rounded-xl"
              >
                {showHistory ? (
                  <>Back to Test</>
                ) : (
                  <>
                    <HistoryIcon className="h-4 w-4 mr-1 text-white/50" /> Stats & History
                  </>
                )}
              </button>
            )}
            {!isTesting && (
              <button
                onClick={() => {
                  setLettersInput(letters.join(', '));
                  setShowSettings(true);
                }}
                title="Admin Settings"
                className="flex items-center justify-center p-2 btn-glass rounded-xl text-white/50 hover:text-white"
              >
                <CogIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </header>

        {/* Main card wrapper */}
        <main className={`w-full glass-strong rounded-3xl p-8 mx-auto flex-1 ${
          isWideLayout
            ? 'max-w-4xl'
            : 'max-w-2xl flex items-center justify-center min-h-[460px]'
        }`}>
          {showHistory ? renderHistorySummary() : renderContent()}
        </main>

        {/* Footer */}
        <footer className="text-center py-6 text-[10px] text-white/30 mt-auto">
          NeuroFlow Cognitive Evaluator &copy; {new Date().getFullYear()} &middot; Built with Gemini 2.5 Flash
        </footer>

        {/* Admin Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fadeIn">
            <div className="glass-strong rounded-3xl w-full max-w-md overflow-hidden animate-slideIn">
              {/* Modal Header */}
              <div className="px-6 py-4 flex justify-between items-center" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}>
                <h3 className="text-base font-bold text-white flex items-center">
                  <CogIcon className="h-5 w-5 text-cyan-400 icon-glow mr-2" /> Admin Settings
                </h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-white/40 hover:text-white/80 text-sm font-bold transition-colors"
                >
                  ✕
                </button>
              </div>
              
              {/* Modal Body */}
              <div className="p-6 space-y-5">
                {/* Patient ID */}
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-white/40 mb-1.5">
                    Patient / User ID
                  </label>
                  <input
                    type="text"
                    value={patientId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPatientId(val);
                      localStorage.setItem('neuroflow_patient_id', val);
                    }}
                    placeholder="e.g. Patient-1"
                    className="w-full px-3.5 py-2 glass-input rounded-xl text-sm"
                  />
                </div>

                {/* Test Duration */}
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-white/40 mb-2">
                    Test Duration
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {DURATION_OPTIONS.map(dur => (
                      <button
                        key={dur}
                        onClick={() => {
                          setTestDuration(dur);
                          setTimeLeft(dur);
                          localStorage.setItem('neuroflow_test_duration', dur.toString());
                        }}
                        className={`py-2.5 rounded-xl text-sm font-bold transition-all ${
                          testDuration === dur
                            ? 'btn-gradient'
                            : 'glass-inner text-white/60 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        {dur}s
                      </button>
                    ))}
                  </div>
                </div>

                {/* Target Letters */}
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-white/40 mb-1.5">
                    Target Letters (Comma Separated)
                  </label>
                  <input
                    type="text"
                    value={lettersInput}
                    onChange={(e) => {
                      const rawVal = e.target.value;
                      setLettersInput(rawVal);
                      
                      const parsedLetters = rawVal
                        .toUpperCase()
                        .split(/[\s,]+/)
                        .map(l => l.trim())
                        .filter(l => l.length === 1 && /[A-Z]/.test(l));
                      
                      if (parsedLetters.length > 0) {
                        setLetters(parsedLetters);
                        localStorage.setItem('neuroflow_target_letters', JSON.stringify(parsedLetters));
                      }
                    }}
                    placeholder="e.g. L, S, B, C"
                    className="w-full px-3.5 py-2 glass-input rounded-xl text-sm"
                  />
                  <p className="text-[10px] text-white/30 mt-1 font-medium">Changes immediately update the letter selection grids.</p>
                </div>

                {/* Gemini API Key */}
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-white/40 mb-1.5">
                    Gemini API Key
                  </label>
                  <input
                    type="password"
                    value={customApiKey}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomApiKey(val);
                      localStorage.setItem('neuroflow_api_key', val);
                    }}
                    placeholder="Enter your GEMINI_API_KEY"
                    className="w-full px-3.5 py-2 glass-input rounded-xl text-sm"
                  />
                  <p className="text-[10px] text-white/30 mt-1 font-medium">
                    {customApiKey ? "Using custom UI key (saved in browser)." : "Using file key from .env.local (if defined)."}
                  </p>
                </div>

                {/* Voice Feedback Switch */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-white/40">
                      Voice Feedback
                    </label>
                    <p className="text-[10px] text-white/30 mt-0.5 font-medium">
                      Enable or mute the verbal clinical coach agent.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      const next = !voiceCoachEnabled;
                      setVoiceCoachEnabled(next);
                      localStorage.setItem('neuroflow_voice_coach', next.toString());
                    }}
                    className={`w-11 h-6 rounded-full transition-all focus:outline-none flex items-center p-1 cursor-pointer
                      ${voiceCoachEnabled ? 'toggle-gradient justify-end' : 'justify-start'}`}
                    style={!voiceCoachEnabled ? { background: 'rgba(255,255,255,0.1)' } : {}}
                  >
                    <span className="w-4 h-4 bg-white rounded-full shadow-sm transition-all"></span>
                  </button>
                </div>

                {/* Theme Mode Switch */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
                      {isDarkMode ? <MoonIcon className="h-3.5 w-3.5 text-cyan-400" /> : <SunIcon className="h-3.5 w-3.5 text-amber-400" />}
                      Interface Theme
                    </label>
                    <p className="text-[10px] text-white/30 mt-0.5 font-medium">
                      Toggle between Glass Dark and Glass Light theme.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      const next = !isDarkMode;
                      setIsDarkMode(next);
                      localStorage.setItem('neuroflow_theme', next ? 'dark' : 'light');
                    }}
                    className={`w-11 h-6 rounded-full transition-all focus:outline-none flex items-center p-1 cursor-pointer
                      ${isDarkMode ? 'toggle-gradient justify-end' : 'justify-start'}`}
                    style={!isDarkMode ? { background: 'rgba(255,255,255,0.1)' } : {}}
                  >
                    <span className="w-4 h-4 bg-white rounded-full shadow-sm transition-all flex items-center justify-center">
                      {isDarkMode ? (
                        <MoonIcon className="h-2.5 w-2.5 text-cyan-950" />
                      ) : (
                        <SunIcon className="h-2.5 w-2.5 text-amber-500" />
                      )}
                    </span>
                  </button>
                </div>
                
                {/* Extra actions */}
                <div className="pt-4 flex flex-col gap-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {result && status === TestStatus.FINISHED && (
                    <button
                      onClick={() => {
                        setShowSettings(false);
                        setTimeout(() => window.print(), 100);
                      }}
                      className="w-full chip-blue font-bold py-2.5 px-4 rounded-xl flex items-center justify-center text-xs transition-all hover:brightness-110"
                    >
                      <PrinterIcon className="h-4 w-4 mr-2" /> Print Active Clinical Report
                    </button>
                  )}
                  
                  <button
                    onClick={() => {
                      exportHistoryToCSV();
                    }}
                    className="w-full btn-glass font-bold py-2.5 px-4 rounded-xl flex items-center justify-center text-xs"
                  >
                    Export History CSV
                  </button>
                </div>
              </div>
              
              {/* Modal Footer */}
              <div className="px-6 py-4 flex justify-end" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                <button
                  onClick={() => setShowSettings(false)}
                  className="btn-gradient font-bold py-2 px-5 rounded-xl text-xs"
                >
                  Close Settings
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Print View Container (Hidden normally, shown only during print) */}
      {result && (
        <div className="hidden print:block p-8 bg-white text-slate-900 max-w-4xl mx-auto font-sans">
          <div className="border-b-2 border-slate-300 pb-4 mb-6">
            <h1 className="text-3xl font-extrabold text-slate-800 tracking-tight">NEUROFLOW AI EVALUATION REPORT</h1>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider mt-1">Clinical Verbal Fluency Assessment</p>
          </div>
          
          <div className="grid grid-cols-2 gap-6 mb-8 text-sm">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Patient Metadata</p>
              <p className="text-lg font-bold text-slate-800 mt-0.5">{result.patientId || 'Patient-1'}</p>
              <p className="text-xs text-slate-500 mt-1">Date: {new Date(result.timestamp).toLocaleString()}</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Fluency Performance</p>
              <p className="text-3xl font-black text-blue-600 mt-0.5">{result.score}</p>
              <p className="text-xs text-slate-500 mt-1">Target Letter: <span className="font-bold">{result.letter}</span> &middot; Duration: {result.testDuration || 30}s</p>
            </div>
          </div>
          
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 mb-6 text-sm">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1">AI Clinical Executive Summary</span>
            <p className="text-slate-800 leading-relaxed font-medium">{result.message}</p>
          </div>
          
          <div className="grid grid-cols-3 gap-6 mb-8">
            <div className="border border-slate-200 rounded-xl p-4 text-center">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-450">Lexical Rarity Index</span>
              <p className="text-2xl font-extrabold text-slate-800 mt-1">{result.lexicalRarityScore || 'N/A'}</p>
              <span className="text-[10px] text-slate-400">(Scale 1.0 - 5.0)</span>
            </div>
            <div className="border border-slate-200 rounded-xl p-4 text-center">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-455">Switching Transitions</span>
              <p className="text-2xl font-extrabold text-slate-800 mt-1">{result.switchingCount}</p>
              <span className="text-[10px] text-slate-400">category shifts</span>
            </div>
            <div className="border border-slate-200 rounded-xl p-4 text-center">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-455">Avg Cluster Size</span>
              <p className="text-2xl font-extrabold text-slate-800 mt-1">{result.clusterSizeAverage}</p>
              <span className="text-[10px] text-slate-400">animals/group</span>
            </div>
          </div>

          {/* Temporal Decay Curve for print */}
          <div className="border border-slate-200 rounded-xl p-5 mb-6 text-sm">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-450 block mb-3">Retrieval Decay Curve (Temporal Dynamics)</span>
            <div className="flex items-end justify-around h-28 max-w-md mx-auto border-b border-slate-200 pb-2">
              {result.epochCounts?.map((count, i) => {
                const maxVal = Math.max(...(result.epochCounts || [1, 1, 1])) || 1;
                const pct = (count / maxVal) * 100;
                return (
                  <div key={i} className="flex flex-col items-center w-20">
                    <span className="text-xs font-bold text-slate-700 mb-1">{count} words</span>
                    <div style={{ height: `${Math.max(pct, 5)}%` }} className="w-full bg-slate-500 rounded-t-sm"></div>
                    <span className="text-[9px] text-slate-400 uppercase tracking-wider mt-1.5 font-bold">Epoch {i+1}</span>
                  </div>
                );
              })}
            </div>
          </div>
          
          {/* Word Timeline for print */}
          <div className="border border-slate-200 rounded-xl p-5 text-sm">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-450 block mb-3">Chronological Spoken Word Timeline</span>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2">
              {result.wordTimestamps && result.wordTimestamps.length > 0 ? (
                result.wordTimestamps.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center py-1 border-b border-slate-100">
                    <span className="font-bold text-slate-800 capitalize">{idx + 1}. {item.word}</span>
                    <span className="text-[10px] text-slate-500 font-mono">+{item.time}s (IWI: {item.iwi}s) {item.isLatencySpike && <span className="text-red-500 font-bold ml-1">(! spike)</span>}</span>
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-400 italic">No spoken words logged.</div>
              )}
            </div>
          </div>
          
          <div className="mt-12 text-center text-[10px] text-slate-400 border-t border-slate-200 pt-4">
            NeuroFlow Evaluation &copy; {new Date().getFullYear()} &middot; Generated via Gemini AI Clinical Assistant
          </div>
        </div>
      )}
    </>
  );
};

export default App;
