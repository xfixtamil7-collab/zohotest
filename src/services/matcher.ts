import stringSimilarity from 'string-similarity';
import { MatchResult } from '../types';

export class MatcherService {
  /**
   * Converts a string to its Tanglish/Tamil phonetic equivalent to normalize variations.
   */
  static toTanglishPhonetic(str: string): string {
    return str
      .toLowerCase()
      .replace(/aa/g, 'a')
      .replace(/ee/g, 'i')
      .replace(/oo/g, 'u')
      .replace(/uu/g, 'u')
      .replace(/ii/g, 'i')
      .replace(/z/g, 's')
      .replace(/zh/g, 'l')
      .replace(/g/g, 'k')
      .replace(/d/g, 't')
      .replace(/b/g, 'p')
      .replace(/j/g, 's')
      .replace(/v/g, 'w')
      .replace(/th/g, 't')
      .replace(/sh/g, 's')
      .replace(/ch/g, 'c')
      .replace(/[^a-z0-9]/g, '') // remove spaces and non-alphanumeric chars
      .replace(/([a-z])\1+/g, '$1'); // reduce duplicate letters
  }

  /**
   * Matches a search query string against a list of target objects using a key extractor function.
   * Returns a MatchResult indicating the best match, score, and match status.
   */
  static match<T>(
    query: string,
    targets: T[],
    keyExtractor: (item: T) => string
  ): MatchResult<T> | null {
    if (!targets || targets.length === 0) {
      return null;
    }

    const cleanQuery = query.trim().toLowerCase();
    const queryAlphanumeric = cleanQuery.replace(/[^a-z0-9]/g, '');
    const queryPhonetic = this.toTanglishPhonetic(cleanQuery);

    let bestTarget = targets[0];
    let bestScore = -1;

    for (const target of targets) {
      const originalText = keyExtractor(target);
      const cleanTarget = originalText.trim().toLowerCase();
      const targetAlphanumeric = cleanTarget.replace(/[^a-z0-9]/g, '');
      const targetPhonetic = this.toTanglishPhonetic(cleanTarget);

      let score = 0;

      if (queryAlphanumeric === targetAlphanumeric) {
        score = 1.0;
      } else if (queryPhonetic && targetPhonetic && queryPhonetic === targetPhonetic) {
        score = 0.95;
      } else if (
        (queryAlphanumeric.length > 2 && targetAlphanumeric.includes(queryAlphanumeric)) ||
        (targetAlphanumeric.length > 2 && queryAlphanumeric.includes(targetAlphanumeric))
      ) {
        score = 0.90;
      } else if (
        (queryPhonetic.length > 2 && targetPhonetic.includes(queryPhonetic)) ||
        (targetPhonetic.length > 2 && queryPhonetic.includes(targetPhonetic))
      ) {
        score = 0.88;
      } else {
        score = stringSimilarity.compareTwoStrings(cleanQuery, cleanTarget);
      }

      if (score > bestScore) {
        bestScore = score;
        bestTarget = target;
      }
    }

    // Determine status based on confidence thresholds
    let status: 'MATCHED' | 'FUZZY_MATCHED' | 'NOT_FOUND' = 'NOT_FOUND';
    if (bestScore >= 0.85) {
      status = 'MATCHED';
    } else if (bestScore >= 0.35) {
      status = 'FUZZY_MATCHED';
    }

    return {
      item: bestTarget,
      score: bestScore,
      status
    };
  }

  /**
   * Helper to filter list of matches above a minimum threshold (e.g. for listing multiple matches).
   */
  static matchMultiple<T>(
    query: string,
    targets: T[],
    keyExtractor: (item: T) => string,
    minThreshold = 0.35
  ): Array<{ item: T; score: number }> {
    if (!targets || targets.length === 0) return [];
    
    const cleanQuery = query.trim().toLowerCase();
    const queryAlphanumeric = cleanQuery.replace(/[^a-z0-9]/g, '');
    const queryPhonetic = this.toTanglishPhonetic(cleanQuery);
    
    return targets
      .map((item) => {
        const originalText = keyExtractor(item);
        const cleanTarget = originalText.trim().toLowerCase();
        const targetAlphanumeric = cleanTarget.replace(/[^a-z0-9]/g, '');
        const targetPhonetic = this.toTanglishPhonetic(cleanTarget);

        let score = 0;

        if (queryAlphanumeric === targetAlphanumeric) {
          score = 1.0;
        } else if (queryPhonetic && targetPhonetic && queryPhonetic === targetPhonetic) {
          score = 0.95;
        } else if (
          (queryAlphanumeric.length > 2 && targetAlphanumeric.includes(queryAlphanumeric)) ||
          (targetAlphanumeric.length > 2 && queryAlphanumeric.includes(targetAlphanumeric))
        ) {
          score = 0.90;
        } else if (
          (queryPhonetic.length > 2 && targetPhonetic.includes(queryPhonetic)) ||
          (targetPhonetic.length > 2 && queryPhonetic.includes(targetPhonetic))
        ) {
          score = 0.88;
        } else {
          score = stringSimilarity.compareTwoStrings(cleanQuery, cleanTarget);
        }

        return { item, score };
      })
      .filter((m) => m.score >= minThreshold)
      .sort((a, b) => b.score - a.score);
  }
}
