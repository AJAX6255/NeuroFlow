import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TestStatus } from './types';
import type { TestResult, CognitiveError, SpeechRecognition, SpeechRecognitionEvent, SpeechRecognitionErrorEvent } from './types';
import { analyzeTranscript } from './services/geminiService';
import { correctWord, isValidLetterMatch } from './utils/phoneticMatcher';
import { saveResult, getHistory, getHistorySummary, clearHistory } from './utils/historyStore';
import { MicrophoneIcon, ProcessingIcon, CheckCircleIcon, ExclamationTriangleIcon, PlayIcon, RestartIcon, BrainIcon, HistoryIcon } from './components/Icons';

const TEST_DURATION = 30; // seconds
const LETTERS = ['L', 'S', 'B', 'C', 'M', 'T', 'W'];
const NUDGE_COOLDOWN = 7000; // 7 seconds pause trigger

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition: SpeechRecognition | null = SpeechRecognition ? new SpeechRecognition() : null;

if (recognition) {
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
}

const App: React.FC = () => {
  const [status, setStatus] = useState<TestStatus>(TestStatus.IDLE);
  const [selectedLetter, setSelectedLetter] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(TEST_DURATION);
  const [rawTranscript, setRawTranscript] = useState<string>("");
  const [liveAnimals, setLiveAnimals] = useState<string[]>([]);
  const [errorsObserved, setErrorsObserved] = useState<CognitiveError[]>([]);
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Dashboard & History tab state
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historySummary, setHistorySummary] = useState(getHistorySummary());

  const timerRef = useRef<number | null>(null);
  const lastWordTimeRef = useRef<number>(Date.now());
  const hasSpokenNudgeRef = useRef<boolean>(false);
  
  // Keep track of speech synthesis so we can abort speaking if needed
  const speakMessage = useCallback((message: string, callback?: () => void) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const femaleVoice = voices.find(v => v.lang.startsWith('en-') && /female/i.test(v.name));
    if (femaleVoice) {
      utterance.voice = femaleVoice;
    }

    if (callback) {
      utterance.onend = callback;
    }
    window.speechSynthesis.speak(utterance);
  }, []);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopListening = useCallback(() => {
    if (recognition && status === TestStatus.LISTENING) {
      recognition.stop();
      stopTimer();
      setStatus(TestStatus.PROCESSING);
    }
  }, [status]);

  // Real-time voice intervention
  const triggerNudge = useCallback(() => {
    if (status !== TestStatus.LISTENING || !selectedLetter) return;
    hasSpokenNudgeRef.current = true;

    // Pause recognition briefly so it doesn't transcribe the agent speaking
    if (recognition) recognition.stop();

    const prompts = [
      `You are doing great! Can you think of any other animals starting with the letter ${selectedLetter}?`,
      `Think about where they live. Are there any water or ocean animals starting with ${selectedLetter}?`,
      `How about farm or domestic animals starting with ${selectedLetter}?`,
      `Take a deep breath. Can you name any birds or insects starting with ${selectedLetter}?`
    ];
    const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];

    speakMessage(randomPrompt, () => {
      // Resume recognition after speaking
      if (status === TestStatus.LISTENING && recognition) {
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

  const processResult = useCallback(async () => {
    if (!rawTranscript || !selectedLetter) {
      const emptyResult: TestResult = {
        score: 0,
        animals: [],
        clusters: [],
        switchingCount: 0,
        clusterSizeAverage: 0,
        errors: errorsObserved,
        message: "It seems we didn't catch anything. Let's try again!",
        timestamp: new Date().toISOString(),
        letter: selectedLetter || 'L'
      };
      setResult(emptyResult);
      saveResult(emptyResult);
      setHistorySummary(getHistorySummary());
      setStatus(TestStatus.FINISHED);
      return;
    }

    try {
      const analysis = await analyzeTranscript(rawTranscript, selectedLetter, errorsObserved);
      const finalResult: TestResult = {
        ...analysis,
        timestamp: new Date().toISOString(),
        letter: selectedLetter
      };
      setResult(finalResult);
      saveResult(finalResult);
      setHistorySummary(getHistorySummary());
      setStatus(TestStatus.FINISHED);
    } catch (e) {
      console.error(e);
      setErrorMsg("Sorry, I had trouble analyzing the results. Please try again.");
      setStatus(TestStatus.ERROR);
    }
  }, [rawTranscript, selectedLetter, errorsObserved]);

  useEffect(() => {
    if (!recognition) {
      setErrorMsg("Speech recognition is not supported by your browser. Please use Chrome or Edge.");
      setStatus(TestStatus.ERROR);
      return;
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
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
          const corrected = correctWord(word, selectedLetter || 'L');
          if (corrected) {
            // Check if it matches the target letter
            if (isValidLetterMatch(corrected, selectedLetter || 'L')) {
              // Check for repetitions
              setLiveAnimals(prev => {
                if (prev.includes(corrected)) {
                  // Pre-log repetition error
                  setErrorsObserved(errs => [...errs, { word: corrected, type: 'repetition' }]);
                  return prev;
                } else {
                  // Unique correct word found! Update timer and list
                  lastWordTimeRef.current = Date.now();
                  return [...prev, corrected];
                }
              });
            } else {
              // Wrong starting letter
              setErrorsObserved(errs => [...errs, { word: corrected, type: 'wrong-letter' }]);
            }
          }
        });
      }
    };
    
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Ignore 'no-speech' or temporary aborts, handle hard errors
      if (event.error === 'no-speech') return;
      console.error('Speech recognition error:', event.error);
      setErrorMsg(`Speech recognition error: ${event.error}. Please ensure microphone access is allowed.`);
      setStatus(TestStatus.ERROR);
      stopTimer();
    };

    recognition.onend = () => {
      // Restart recognition if we are still in listening mode
      if (status === TestStatus.LISTENING) {
        try {
          recognition.start();
        } catch (e) {
          console.error(e);
        }
      }
    };
  }, [status, selectedLetter]);

  // Active nudge interval checker
  useEffect(() => {
    let nudgeInterval: number | null = null;
    if (status === TestStatus.LISTENING) {
      nudgeInterval = window.setInterval(() => {
        const idleTime = Date.now() - lastWordTimeRef.current;
        if (idleTime > NUDGE_COOLDOWN && !hasSpokenNudgeRef.current) {
          triggerNudge();
        }
      }, 1000);
    }
    return () => {
      if (nudgeInterval) clearInterval(nudgeInterval);
    };
  }, [status, triggerNudge]);

  useEffect(() => {
    if (status === TestStatus.PROCESSING) {
      processResult();
    }
  }, [status, processResult]);

  useEffect(() => {
    if (status === TestStatus.FINISHED && result?.message) {
      speakMessage(result.message);
    }
  }, [status, result, speakMessage]);

  useEffect(() => {
    return () => {
      if (recognition) recognition.abort();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      stopTimer();
    };
  }, []);

  const startTest = () => {
    if (!selectedLetter) return;
    setErrorMsg(null);
    setResult(null);
    setRawTranscript("");
    setLiveAnimals([]);
    setErrorsObserved([]);
    setTimeLeft(TEST_DURATION);
    setStatus(TestStatus.LISTENING);
    lastWordTimeRef.current = Date.now();
    hasSpokenNudgeRef.current = false;
    
    try {
      if (recognition) {
        recognition.start();
      }
    } catch(e) {
      console.error("Error starting recognition: ", e);
      setStatus(TestStatus.IDLE);
    }

    timerRef.current = window.setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          stopListening();
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
    setStatus(TestStatus.IDLE);
    setSelectedLetter(null);
    setRawTranscript("");
    setLiveAnimals([]);
    setErrorsObserved([]);
    setResult(null);
    setErrorMsg(null);
    setTimeLeft(TEST_DURATION);
  };

  const progress = ((TEST_DURATION - timeLeft) / TEST_DURATION) * 100;

  const renderContent = () => {
    switch (status) {
      case TestStatus.LISTENING:
        return (
          <div className="flex flex-col items-center justify-center text-center">
            <div className="relative w-52 h-52 flex items-center justify-center">
              <svg className="absolute w-full h-full transform -rotate-90" viewBox="0 0 224 224">
                <circle className="text-slate-200 dark:text-slate-700" strokeWidth="12" stroke="currentColor" fill="transparent" r="100" cx="112" cy="112" />
                <circle
                  className="text-blue-500 transition-all duration-300"
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
                 <MicrophoneIcon className="h-16 w-16 mb-2 text-blue-500 animate-pulse" />
                 <span className="text-5xl font-extrabold font-sans tracking-tight text-slate-800 dark:text-slate-100">{timeLeft}</span>
              </div>
            </div>
            <p className="mt-8 text-lg font-medium text-slate-700 dark:text-slate-300">Name animals starting with '<span className="text-blue-500 font-bold">{selectedLetter}</span>'...</p>
            
            {/* Live transcribing feedback */}
            <div className="mt-6 w-full max-w-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="flex justify-between items-center mb-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Identified Animals ({liveAnimals.length})</span>
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto">
                {liveAnimals.length > 0 ? (
                  liveAnimals.map((animal, idx) => (
                    <span key={idx} className="px-2.5 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-xs font-semibold rounded-full capitalize">
                      {animal}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-400 italic">Listening for animal names...</span>
                )}
              </div>
            </div>
          </div>
        );

      case TestStatus.PROCESSING:
        return (
          <div className="flex flex-col items-center justify-center text-center py-10">
            <ProcessingIcon className="h-16 w-16 text-blue-500 animate-spin" />
            <p className="mt-6 text-xl font-semibold text-slate-700 dark:text-slate-300">Analyzing speech patterns...</p>
            <p className="mt-2 text-sm text-slate-400">Classifying semantic clusters and evaluating cognitive switching speed</p>
          </div>
        );

      case TestStatus.FINISHED:
        return (
          <div className="w-full">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold flex items-center text-slate-800 dark:text-slate-100">
                <CheckCircleIcon className="h-7 w-7 text-green-500 mr-2.5"/> Test Results
              </h2>
              <span className="text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-3 py-1.5 rounded-full font-mono">
                Letter: {result?.letter}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left Column: Big Score Card */}
              <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl p-6 text-white flex flex-col items-center justify-center shadow-lg">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-100 mb-2">Fluency Score</span>
                <span className="text-7xl font-extrabold leading-none">{result?.score}</span>
                <span className="text-sm font-medium text-blue-100 mt-3 text-center">valid unique animals</span>
              </div>

              {/* Middle & Right Column: Details */}
              <div className="md:col-span-2 space-y-4">
                <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Coach Feedback</span>
                  <p className="mt-2 text-slate-700 dark:text-slate-300 font-medium leading-relaxed">{result?.message}</p>
                </div>

                {/* Sub-metrics */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Switching Speed</span>
                    <p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 mt-1">{result?.switchingCount}</p>
                    <span className="text-2xs text-slate-400">category transitions</span>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Avg Cluster Size</span>
                    <p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 mt-1">{result?.clusterSizeAverage}</p>
                    <span className="text-2xs text-slate-400 font-medium">animals per group</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Semantic Clusters Section */}
            <div className="mt-6 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block mb-3">Semantic Categories Used</span>
              <div className="flex flex-wrap gap-4">
                {result?.clusters && result.clusters.length > 0 ? (
                  result.clusters.map((cluster, i) => (
                    <div key={i} className="flex-1 min-w-[200px] bg-white dark:bg-slate-800 border border-slate-150 dark:border-slate-750 rounded-xl p-3.5 shadow-2xs">
                      <span className="text-xs font-bold text-blue-600 dark:text-blue-400 capitalize">{cluster.category}</span>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {cluster.animals.map((anim, idx) => (
                          <span key={idx} className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-655 dark:text-slate-300 text-2xs font-medium rounded-md capitalize">
                            {anim}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <span className="text-sm text-slate-400 italic">No semantic groups identified.</span>
                )}
              </div>
            </div>

            {/* Errors Card */}
            {result?.errors && result.errors.length > 0 && (
              <div className="mt-4 bg-red-50 dark:bg-red-950/20 border border-red-150 dark:border-red-950/30 rounded-2xl p-5 shadow-sm">
                <span className="text-xs font-bold uppercase tracking-wider text-red-500 block mb-2">Speech Errors & Repetitions</span>
                <div className="flex flex-wrap gap-2">
                  {result.errors.map((err, i) => (
                    <span key={i} className="px-2.5 py-1 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-2xs font-semibold rounded-md capitalize">
                      {err.word} <span className="opacity-60 text-3xs font-medium">({err.type})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={resetTest}
              className="mt-8 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-7 rounded-xl flex items-center justify-center mx-auto transition-all shadow-md hover:-translate-y-0.5"
            >
              <RestartIcon className="h-5 w-5 mr-2" />
              Practice Again
            </button>
          </div>
        );

      case TestStatus.ERROR:
        return (
          <div className="text-center flex flex-col items-center py-6">
            <ExclamationTriangleIcon className="h-14 w-14 text-red-500 mb-4"/>
            <h2 className="text-2xl font-bold text-red-600 dark:text-red-400">An Error Occurred</h2>
            <p className="mt-2 text-slate-600 dark:text-slate-400 max-w-sm">{errorMsg}</p>
            <button
              onClick={resetTest}
              className="mt-8 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl flex items-center justify-center mx-auto transition-all shadow-md"
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
              <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-2xl">
                <BrainIcon className="h-10 w-10 text-blue-500" />
              </div>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">NeuroFlow Cognitive Trainer</h1>
            <p className="text-sm text-slate-400 max-w-md mx-auto mt-1 mb-8">Evolving verbal fluency practice with active speech interventions and cognitive semantic maps.</p>
            
            {!selectedLetter ? (
               <>
                <p className="text-base font-semibold text-slate-700 dark:text-slate-300 mb-4">Select a letter to begin the evaluation:</p>
                <div className="flex flex-wrap justify-center gap-3.5 max-w-md mx-auto">
                    {LETTERS.map(letter => (
                        <button 
                            key={letter}
                            onClick={() => setSelectedLetter(letter)}
                            className="w-14 h-14 text-xl font-bold rounded-xl transition-all transform focus:outline-none
                                       bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-350
                                       border border-slate-200 dark:border-slate-700
                                       hover:-translate-y-0.5 hover:bg-slate-100 dark:hover:bg-slate-700 hover:border-slate-300 dark:hover:border-slate-600
                                       active:translate-y-0 active:shadow-inner shadow-xs"
                        >
                            {letter}
                        </button>
                    ))}
                </div>
               </>
            ) : (
                <>
                <p className="text-slate-600 dark:text-slate-400 mb-6">You will name as many animals as you can that start with the letter:</p>
                <div className="flex flex-wrap justify-center gap-3.5 max-w-md mx-auto mb-8">
                     {LETTERS.map(letter => (
                        <button 
                            key={letter}
                            onClick={() => setSelectedLetter(letter)}
                            className={`w-14 h-14 text-xl font-bold rounded-xl transition-all transform focus:outline-none border
                                ${selectedLetter === letter 
                                    ? 'bg-blue-600 text-white border-blue-700 shadow-md translate-y-px'
                                    : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-350 border-slate-200 dark:border-slate-700 hover:-translate-y-0.5 hover:bg-slate-100 dark:hover:bg-slate-700'
                                }`}
                        >
                            {letter}
                        </button>
                     ))}
                </div>
                
                <div className="flex gap-4 max-w-md mx-auto">
                  <button
                    onClick={() => setSelectedLetter(null)}
                    className="flex-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold py-3.5 px-6 rounded-xl transition-all border border-slate-200 dark:border-slate-700"
                  >
                    Back
                  </button>
                  <button
                    onClick={startTest}
                    className="flex-2 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-8 rounded-xl flex items-center justify-center transition-all shadow-md hover:-translate-y-0.5"
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
          <h2 className="text-2xl font-bold flex items-center text-slate-800 dark:text-slate-100">
            <HistoryIcon className="h-6 w-6 text-blue-500 mr-2.5"/> Practice History
          </h2>
          <button
            onClick={() => {
              clearHistory();
              setHistorySummary(getHistorySummary());
            }}
            className="text-xs font-semibold text-red-500 hover:text-red-600 transition-colors"
          >
            Clear History
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 text-center shadow-xs">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Evaluations</span>
            <p className="text-4xl font-extrabold text-slate-800 dark:text-slate-100 mt-1">{historySummary.totalTests}</p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 text-center shadow-xs">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Average Score</span>
            <p className="text-4xl font-extrabold text-slate-800 dark:text-slate-100 mt-1">{historySummary.averageScore}</p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 text-center shadow-xs">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Personal Best</span>
            <p className="text-4xl font-extrabold text-slate-800 dark:text-slate-100 mt-1">{historySummary.bestScore}</p>
          </div>
        </div>

        {/* Breakdown by letter */}
        <div className="mb-6 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-xs">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-3">Score Breakdown by Letter</span>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3">
            {LETTERS.map(letter => {
              const info = historySummary.byLetter[letter] || { count: 0, avgScore: 0 };
              return (
                <div key={letter} className="bg-white dark:bg-slate-800 border border-slate-150 dark:border-slate-750 rounded-xl p-3 text-center">
                  <span className="text-sm font-bold text-blue-600 dark:text-blue-400">{letter}</span>
                  <p className="text-lg font-extrabold text-slate-800 dark:text-slate-100">{info.avgScore}</p>
                  <span className="text-3xs text-slate-400">({info.count} tests)</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* History table list */}
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Evaluation Log</span>
          </div>
          <div className="max-h-60 overflow-y-auto divide-y divide-slate-150 dark:divide-slate-800">
            {getHistory().slice().reverse().map((item, idx) => {
              const dateObj = new Date(item.timestamp);
              return (
                <div key={idx} className="px-5 py-3 flex justify-between items-center bg-white dark:bg-slate-800">
                  <div>
                    <span className="text-sm font-bold text-slate-750 dark:text-slate-200">Letter: {item.letter}</span>
                    <p className="text-3xs text-slate-400">{dateObj.toLocaleDateString()} {dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-extrabold text-slate-850 dark:text-slate-100">Score: {item.score}</span>
                    <p className="text-3xs text-slate-400">{item.switchingCount} switches</p>
                  </div>
                </div>
              );
            })}
            {historySummary.totalTests === 0 && (
              <div className="px-5 py-6 text-center text-sm text-slate-450 italic">No past tests logged yet.</div>
            )}
          </div>
        </div>

        <button
          onClick={() => setShowHistory(false)}
          className="mt-8 bg-slate-150 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-350 font-bold py-3.5 px-7 rounded-xl flex items-center justify-center mx-auto transition-all shadow-sm"
        >
          Back to Evaluation
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 flex flex-col justify-between p-4">
      {/* Top Navbar */}
      <header className="w-full max-w-2xl mx-auto flex justify-between items-center py-4">
        <span className="text-base font-extrabold tracking-tight bg-gradient-to-r from-blue-500 to-indigo-600 bg-clip-text text-transparent flex items-center">
          <BrainIcon className="h-5 w-5 text-blue-500 mr-1.5" /> NeuroFlow AI
        </span>
        {status === TestStatus.IDLE && (
          <button
            onClick={() => {
              setShowHistory(prev => !prev);
              setHistorySummary(getHistorySummary());
            }}
            className="flex items-center text-xs font-semibold px-3 py-2 bg-white dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-xl hover:-translate-y-0.5 transition-all shadow-3xs"
          >
            {showHistory ? (
              <>Back to Test</>
            ) : (
              <>
                <HistoryIcon className="h-4 w-4 mr-1 text-slate-500" /> Stats & History
              </>
            )}
          </button>
        )}
      </header>

      {/* Main card wrapper */}
      <main className="w-full max-w-2xl bg-white dark:bg-slate-800 rounded-3xl shadow-xl p-8 flex items-center justify-center min-h-[460px] mx-auto border border-slate-150 dark:border-slate-750">
        {showHistory ? renderHistorySummary() : renderContent()}
      </main>

      {/* Footer */}
      <footer className="text-center py-6 text-3xs text-slate-400">
        NeuroFlow Cognitive Evaluator &copy; {new Date().getFullYear()} &middot; Built with Gemini 2.5 Flash
      </footer>
    </div>
  );
};

export default App;
