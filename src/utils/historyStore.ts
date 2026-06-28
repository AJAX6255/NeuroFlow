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
