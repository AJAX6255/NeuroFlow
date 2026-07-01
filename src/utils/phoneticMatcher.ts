// Curated dictionary of common animals starting with target letters
export const ANIMAL_DICTIONARY: Record<string, string[]> = {
  L: ['lion', 'leopard', 'llama', 'lizard', 'lamb', 'lobster', 'lemur', 'lynx', 'locust', 'leech', 'lark', 'loon', 'leopard seal', 'ladybug', 'leopard gecko', 'leopard frog', 'lyre bird', 'lion fish', 'leatherback turtle', 'lake trout'],
  S: ['snake', 'sheep', 'shark', 'spider', 'snail', 'squirrel', 'swan', 'seal', 'skunk', 'swallow', 'salmon', 'sparrow', 'starling', 'sloth', 'scorpion', 'seagull', 'sea lion', 'sea turtle', 'sea horse', 'spider monkey', 'sand crab', 'sand dab', 'sand dollar', 'snow leopard', 'snowy owl', 'snapping turtle', 'sperm whale', 'sword fish', 'spiny lobster', 'sheep dog'],
  B: ['bear', 'beaver', 'badger', 'bat', 'bee', 'buffalo', 'bull', 'butterfly', 'baboon', 'beetle', 'bison', 'boar', 'bobcat', 'budgie', 'barracuda', 'black bear', 'brown bear', 'blue whale', 'bald eagle', 'bull frog', 'barn owl', 'bumble bee', 'basking shark', 'blue jay'],
  C: ['cat', 'cow', 'cheetah', 'camel', 'chimpanzee', 'crab', 'caterpillar', 'chicken', 'crow', 'cobra', 'crane', 'crocodile', 'coyote', 'chinchilla', 'clown fish', 'cray fish', 'cape buffalo', 'canada goose'],
  M: ['monkey', 'mouse', 'mole', 'moose', 'manatee', 'magpie', 'moth', 'mosquito', 'mule', 'marmot', 'mink', 'meerkat', 'macaque', 'mockingbird', 'mountain lion', 'mocking bird', 'monarch butterfly', 'mule deer', 'marine iguana'],
  T: ['tiger', 'turtle', 'toad', 'turkey', 'trout', 'tarantula', 'tapir', 'toucan', 'termite', 'thrush', 'tortoise', 'tadpole', 'tiger shark', 'tree frog', 'tiger salamander', 'tsetse fly', 'turkey vulture', 'thorny devil'],
  W: ['wolf', 'whale', 'walrus', 'wasp', 'weasel', 'worm', 'woodpecker', 'wombat', 'wildebeest', 'wallaby', 'warthog', 'white tiger', 'white shark', 'wood frog', 'wild boar', 'wild cat']
};

// Map of common spoken homophones or speech-to-text misinterpretations
const COMMON_MISHEARD_MAP: Record<string, string> = {
  // L homophones / errors
  'lamp': 'lamb',
  'limb': 'lamb',
  'land': 'lamb',
  'line': 'lion',
  'lying': 'lion',
  'lines': 'lion',
  'wizard': 'lizard',
  'shepherd': 'leopard', // If letter is L, shepherd is likely leopard
  'lama': 'llama',
  
  // S homophones / errors
  'sleep': 'sheep',
  'ship': 'sheep',
  'soak': 'seal',
  'cereal': 'seal',
  
  // B homophones / errors
  'bare': 'bear',
  'beer': 'bear',
  'beever': 'beaver',
  
  // C homophones / errors
  'kat': 'cat',
  'coyote': 'coyote',
  
  // M homophones / errors
  'mouth': 'mouse',
  'must': 'moth',
  
  // T homophones / errors
  'turtle': 'turtle',
  
  // W homophones / errors
  'mail': 'whale',
  'wheel': 'whale',
  'warn': 'worm'
};

// Simple Levenshtein distance calculation
export const getLevenshteinDistance = (a: string, b: string): number => {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
};

// Plural to singular rules (very basic)
export const singularize = (word: string): string => {
  if (word.endsWith('ies')) {
    return word.slice(0, -3) + 'y';
  }
  if (word.endsWith('es') && !word.endsWith('ees')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
};

/**
 * Phonetically corrects a transcribed word to a valid animal if a match is found.
 * 
 * @param inputWord The word transcribed by speech-to-text
 * @param letter The active test letter (uppercase)
 */
export const correctWord = (inputWord: string, letter: string): string => {
  const cleaned = inputWord.trim().toLowerCase();
  if (!cleaned) return '';

  const singular = singularize(cleaned);

  // 1. Check direct homophone/misheard map first
  if (COMMON_MISHEARD_MAP[cleaned]) {
    return COMMON_MISHEARD_MAP[cleaned];
  }
  if (COMMON_MISHEARD_MAP[singular]) {
    return COMMON_MISHEARD_MAP[singular];
  }

  // 2. Check if the word is already a known animal in our dictionary
  const knownAnimals = ANIMAL_DICTIONARY[letter] || [];
  if (knownAnimals.includes(cleaned)) {
    return cleaned;
  }
  if (knownAnimals.includes(singular)) {
    return singular;
  }

  // 3. Find closest word using Levenshtein distance
  let bestMatch = cleaned;
  let minDistance = Infinity;

  for (const animal of knownAnimals) {
    const dist = getLevenshteinDistance(singular, animal);
    if (dist < minDistance) {
      minDistance = dist;
      bestMatch = animal;
    }
  }

  // Allow correction if the edit distance is very small (1 character difference)
  // or if it's a longer word and has a distance of 2
  if (minDistance === 1 || (singular.length > 5 && minDistance <= 2)) {
    return bestMatch;
  }

  // If no good correction is found, return the singularized input
  return singular;
};

/**
 * Helper to check if a corrected word starts with the target letter.
 */
export const isValidLetterMatch = (word: string, letter: string): boolean => {
  return word.toLowerCase().startsWith(letter.toLowerCase());
};
