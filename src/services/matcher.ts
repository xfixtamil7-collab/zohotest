import stringSimilarity from 'string-similarity';
import { MatchResult } from '../types';

export class MatcherService {
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
    const candidateStrings = targets.map((t) => keyExtractor(t).trim().toLowerCase());

    // Compute similarity scores
    const matches = stringSimilarity.findBestMatch(cleanQuery, candidateStrings);
    const bestMatchIndex = matches.bestMatchIndex;
    const score = matches.bestMatch.rating;
    const bestTarget = targets[bestMatchIndex];

    // Determine status based on confidence thresholds
    let status: 'MATCHED' | 'FUZZY_MATCHED' | 'NOT_FOUND' = 'NOT_FOUND';
    if (score >= 0.85) {
      status = 'MATCHED';
    } else if (score >= 0.35) {
      status = 'FUZZY_MATCHED';
    }

    return {
      item: bestTarget,
      score,
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
    
    return targets
      .map((item) => {
        const text = keyExtractor(item).trim().toLowerCase();
        const score = stringSimilarity.compareTwoStrings(cleanQuery, text);
        return { item, score };
      })
      .filter((m) => m.score >= minThreshold)
      .sort((a, b) => b.score - a.score);
  }
}
