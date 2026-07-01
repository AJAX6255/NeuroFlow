import type { TestResult } from '../types';

const STORAGE_KEY = 'neuroflow_test_history';

export const saveResult = (result: TestResult): void => {
  try {
    const history = getHistory();
    history.push(result);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Failed to save test result to history:', error);
  }
};

export const getHistory = (): TestResult[] => {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data) as TestResult[];
  } catch (error) {
    console.error('Failed to retrieve test history:', error);
    return [];
  }
};

export const clearHistory = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear test history:', error);
  }
};

export interface ProgressSummary {
  totalTests: number;
  averageScore: number;
  bestScore: number;
  recentScores: { date: string; score: number }[];
  byLetter: Record<string, { count: number; avgScore: number }>;
}

export const getHistorySummary = (): ProgressSummary => {
  const history = getHistory();
  if (history.length === 0) {
    return {
      totalTests: 0,
      averageScore: 0,
      bestScore: 0,
      recentScores: [],
      byLetter: {}
    };
  }

  let totalScore = 0;
  let bestScore = 0;
  const byLetter: Record<string, { count: number; totalScore: number }> = {};

  history.forEach(item => {
    totalScore += item.score;
    if (item.score > bestScore) {
      bestScore = item.score;
    }

    const letter = item.letter.toUpperCase();
    if (!byLetter[letter]) {
      byLetter[letter] = { count: 0, totalScore: 0 };
    }
    byLetter[letter].count += 1;
    byLetter[letter].totalScore += item.score;
  });

  const formattedByLetter: Record<string, { count: number; avgScore: number }> = {};
  for (const [letter, data] of Object.entries(byLetter)) {
    formattedByLetter[letter] = {
      count: data.count,
      avgScore: Math.round((data.totalScore / data.count) * 10) / 10
    };
  }

  // Get last 7 scores for plotting
  const recent = history.slice(-7).map(item => {
    const dateObj = new Date(item.timestamp);
    return {
      date: `${dateObj.getMonth() + 1}/${dateObj.getDate()}`,
      score: item.score
    };
  });

  return {
    totalTests: history.length,
    averageScore: Math.round((totalScore / history.length) * 10) / 10,
    bestScore,
    recentScores: recent,
    byLetter: formattedByLetter
  };
};

export const exportHistoryToCSV = (): void => {
  const history = getHistory();
  if (history.length === 0) {
    alert("No test history available to export.");
    return;
  }

  // Define headers
  const headers = [
    'Timestamp',
    'Patient ID',
    'Letter',
    'Duration (s)',
    'Fluency Score (Valid)',
    'Lexical Rarity Score',
    'Average IWI (s)',
    'Latency Spikes (>4s)',
    'Semantic Switches',
    'Phonetic Switches',
    'Unrelated Switches',
    'Total Words Spoken',
    'All Spoken Words'
  ];

  const rows = history.map(item => {
    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    
    // Count latency spikes
    const spikes = item.wordTimestamps?.filter(t => t.isLatencySpike).length || 0;
    const totalWords = item.wordTimestamps?.length || 0;
    const wordsList = item.wordTimestamps?.map(t => `${t.word} (${t.time}s)`).join(', ') || '';

    // Calculate transition counts on the fly
    const semCount = item.switchClassifications?.filter(s => s.type === 'semantic').length || 0;
    const phonCount = item.switchClassifications?.filter(s => s.type === 'phonological').length || 0;
    const unrelCount = item.switchClassifications?.filter(s => s.type === 'unrelated').length || 0;

    return [
      escapeCsv(new Date(item.timestamp).toLocaleString()),
      escapeCsv(item.patientId || 'Patient-1'),
      escapeCsv(item.letter),
      item.testDuration || 30,
      item.score,
      item.lexicalRarityScore || 'N/A',
      item.averageIwi || 'N/A',
      spikes,
      semCount,
      phonCount,
      unrelCount,
      totalWords,
      escapeCsv(wordsList)
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map(r => r.join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `neuroflow_clinical_history_${new Date().toISOString().slice(0,10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
