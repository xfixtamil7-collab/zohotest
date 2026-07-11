import stringSimilarity from 'string-similarity';
import { MatchResult } from '../types';

export class MatcherService {
  /**
   * Converts a string to its Tanglish/Tamil phonetic equivalent to normalize variations.
   */
  static toTanglishPhonetic(str: string): string {
    return str
      .toLowerCase()
      // --- Pre-normalize common English fruit/ingredient names to French phonetic roots ---
      // This bridges Tamil-spoken English words → French product name equivalents
      // e.g. "mango" (spoken) ↔ "mangue" (French) → both normalize to "mang"
      .replace(/\bmangue\b/g, 'mang')    // French "mangue" → "mang"
      .replace(/\bmango\b/g, 'mang')     // English "mango" → "mang"
      .replace(/\bstrawberry\b/g, 'fres').replace(/\bfraise\b/g, 'fres') // fraise=strawberry
      .replace(/\bpineapple\b/g, 'ananas').replace(/\bananas\b/g, 'ananas')
      .replace(/\bcoconut\b/g, 'coco').replace(/\bcoco\b/g, 'coco')
      .replace(/\bbanana\b/g, 'banan').replace(/\bbanane\b/g, 'banan')
      .replace(/\bpeach\b/g, 'pec').replace(/\bpeche\b/g, 'pec').replace(/\bp[eê]che\b/g, 'pec')
      .replace(/\blemon\b/g, 'sitron').replace(/\bcitron\b/g, 'sitron')
      .replace(/\bmaaza\b/g, 'masa').replace(/\bmasque\b/g, 'masa') // brand/French mask → "masa"
      // --- Standard Tanglish phonetic rules ---
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
   * Normalizes French product names to a phonetic base that matches how
   * Tamil/Tanglish speakers would pronounce them.
   *
   * Examples:
   *   "Masque Mangue" → "mask mang"   (spoken as "Masa Mango")
   *   "Aloe Vera"     → "alo vera"    (spoken as "Aloe Vera" / "Alo Wera")
   *   "Citron Vert"   → "sitron wer"
   *   "Fraise"        → "fres"
   *   "Ananas"        → "ananas"
   *   "Noix de Coco"  → "noa de coco"
   */
  static toFrenchPhonetic(str: string): string {
    return str
      .toLowerCase()
      // French silent endings & accents
      .replace(/[àâä]/g, 'a')
      .replace(/[éèêë]/g, 'e')
      .replace(/[îï]/g, 'i')
      .replace(/[ôö]/g, 'o')
      .replace(/[ùûü]/g, 'u')
      .replace(/ç/g, 's')
      .replace(/œ/g, 'oe')
      .replace(/æ/g, 'ae')
      // French silent letters / nasal endings
      .replace(/que$/g, 'k')       // "masque" → "mask"
      .replace(/que\b/g, 'k')
      .replace(/que/g, 'k')        // mid-word
      .replace(/gue\b/g, 'g')
      .replace(/gue/g, 'g')
      .replace(/eaux\b/g, 'o')     // "gateaux" → "gato"
      .replace(/eau\b/g, 'o')
      .replace(/eux\b/g, 'e')
      .replace(/aux\b/g, 'o')
      .replace(/ais\b/g, 'e')      // "fraise" endings
      .replace(/ais/g, 'e')
      .replace(/ait\b/g, 'e')
      .replace(/ert\b/g, 'er')     // "vert" → "ver"
      .replace(/and\b/g, 'an')
      .replace(/ent\b/g, 'an')
      .replace(/ant\b/g, 'an')
      .replace(/ange\b/g, 'anj')
      // French digraphs
      .replace(/ph/g, 'f')
      .replace(/ch/g, 's')         // "chocolat" → "sokola"
      .replace(/gn/g, 'ny')
      .replace(/qu/g, 'k')
      // Remove silent trailing consonants common in French
      .replace(/([^aeiou])s\b/g, '$1')  // silent trailing s after consonant
      .replace(/t\b/g, '')              // silent trailing t
      .replace(/d\b/g, '')              // silent trailing d
      .replace(/x\b/g, '')              // silent trailing x
      .replace(/[^a-z0-9 ]/g, '')       // keep spaces for token matching
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Splits a string into tokens and returns a flat phonetic string (no spaces).
   * Used for substring / token-level cross-language matching.
   */
  private static toPhoneticFlat(str: string): string {
    return this.toFrenchPhonetic(this.toTanglishPhonetic(str));
  }

  /**
   * Scores how well two strings match using token-level cross-language comparison.
   * Each query token is matched against each target token; averaged.
   * E.g. "masa mango" vs "masque mangue"
   *   tokens query:  ["masa", "mango"]
   *   tokens target: ["mask", "mang"]   (after French phonetic)
   *   "masa" vs "mask" → ~0.75, "mango" vs "mang" → ~0.80 → avg ≈ 0.78
   */
  private static tokenCrossScore(query: string, target: string): number {
    const qTokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Apply French phonetic to target tokens, Tanglish phonetic to query tokens
    const qPhoneticTokens = qTokens.map(t => this.toTanglishPhonetic(t));

    const tRaw = target.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const tFrenchTokens = tRaw.map(t => this.toFrenchPhonetic(t));
    const tTanglishTokens = tRaw.map(t => this.toTanglishPhonetic(t));

    if (qPhoneticTokens.length === 0 || tFrenchTokens.length === 0) return 0;

    let totalScore = 0;
    for (const qt of qPhoneticTokens) {
      let bestTokenScore = 0;
      // Compare against French-normalized target tokens
      for (const tt of tFrenchTokens) {
        const s = stringSimilarity.compareTwoStrings(qt, tt);
        if (s > bestTokenScore) bestTokenScore = s;
      }
      // Also compare against Tanglish-normalized target tokens
      for (const tt of tTanglishTokens) {
        const s = stringSimilarity.compareTwoStrings(qt, tt);
        if (s > bestTokenScore) bestTokenScore = s;
      }
      // Also check if the query token is a substring of any target token or vice versa
      for (const tt of [...tFrenchTokens, ...tTanglishTokens]) {
        if (qt.length > 2 && tt.includes(qt)) bestTokenScore = Math.max(bestTokenScore, 0.85);
        if (tt.length > 2 && qt.includes(tt)) bestTokenScore = Math.max(bestTokenScore, 0.82);
      }
      totalScore += bestTokenScore;
    }
    return totalScore / qPhoneticTokens.length;
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
      const targetFrenchPhonetic = this.toFrenchPhonetic(cleanTarget).replace(/\s+/g, '');

      let score = 0;

      if (queryAlphanumeric === targetAlphanumeric) {
        // Exact alphanumeric match
        score = 1.0;
      } else if (queryPhonetic && targetPhonetic && queryPhonetic === targetPhonetic) {
        // Exact Tanglish phonetic match
        score = 0.95;
      } else if (queryPhonetic && targetFrenchPhonetic && queryPhonetic === targetFrenchPhonetic) {
        // Tanglish query matches French phonetic of target (e.g. "masa" → "masque"→"mask"→"mask")
        score = 0.93;
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
      } else if (
        (queryPhonetic.length > 2 && targetFrenchPhonetic.includes(queryPhonetic)) ||
        (targetFrenchPhonetic.length > 2 && queryPhonetic.includes(targetFrenchPhonetic))
      ) {
        // Substring match after French normalization
        score = 0.86;
      } else {
        // 1) Standard string similarity
        const strSim = stringSimilarity.compareTwoStrings(cleanQuery, cleanTarget);
        // 2) Token-level cross-language score (Tamil spoken vs French stored)
        const tokenSim = this.tokenCrossScore(cleanQuery, cleanTarget);
        // 3) Phonetic cross-comparison (queryPhonetic vs targetFrenchPhonetic, no spaces)
        const phonCross = stringSimilarity.compareTwoStrings(queryPhonetic, targetFrenchPhonetic);
        // Take the best of the three strategies
        score = Math.max(strSim, tokenSim, phonCross);
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
        const targetFrenchPhonetic = this.toFrenchPhonetic(cleanTarget).replace(/\s+/g, '');

        let score = 0;

        if (queryAlphanumeric === targetAlphanumeric) {
          score = 1.0;
        } else if (queryPhonetic && targetPhonetic && queryPhonetic === targetPhonetic) {
          score = 0.95;
        } else if (queryPhonetic && targetFrenchPhonetic && queryPhonetic === targetFrenchPhonetic) {
          score = 0.93;
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
        } else if (
          (queryPhonetic.length > 2 && targetFrenchPhonetic.includes(queryPhonetic)) ||
          (targetFrenchPhonetic.length > 2 && queryPhonetic.includes(targetFrenchPhonetic))
        ) {
          score = 0.86;
        } else {
          const strSim = stringSimilarity.compareTwoStrings(cleanQuery, cleanTarget);
          const tokenSim = this.tokenCrossScore(cleanQuery, cleanTarget);
          const phonCross = stringSimilarity.compareTwoStrings(queryPhonetic, targetFrenchPhonetic);
          score = Math.max(strSim, tokenSim, phonCross);
        }

        return { item, score };
      })
      .filter((m) => m.score >= minThreshold)
      .sort((a, b) => b.score - a.score);
  }
}
