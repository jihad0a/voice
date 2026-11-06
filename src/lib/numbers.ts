// Core logic: generating the test, normalising what the speech engine heard
// into a digit sequence, and aligning it against the expected digits.

export function generateNumbers(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let n: number;
    do {
      n = 1 + Math.floor(Math.random() * 9); // 1-9, no immediate repeats
    } while (i > 0 && n === out[i - 1]);
    out.push(n);
  }
  return out;
}

const WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nought: "0", naught: "0",
  one: "1", won: "1", wan: "1",
  two: "2", to: "2", too: "2", tu: "2",
  three: "3", tree: "3", free: "3",
  four: "4", for: "4", fore: "4", floor: "4",
  five: "5", fife: "5",
  six: "6", sick: "6", sics: "6", sex: "6",
  seven: "7", heaven: "7",
  eight: "8", ate: "8", eat: "8",
  nine: "9", nein: "9", line: "9", nye: "9",
};

/** Turn a raw transcript into a flat list of single digits. */
export function transcriptToDigits(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const digits: string[] = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      // "123" from engines that merge spoken digits -> 1,2,3
      digits.push(...tok.split(""));
    } else if (WORDS[tok]) {
      digits.push(WORDS[tok]);
    }
  }
  return digits;
}

export type CellStatus = "correct" | "wrong" | "missed";

export interface CellResult {
  expected: number;
  heard: string | null;
  status: CellStatus;
}

export interface Grade {
  cells: CellResult[];
  extra: number; // digits heard that did not map to any expected number
  heard: string[];
}

/**
 * Needleman-Wunsch alignment so one skipped / extra number doesn't shift
 * (and wrongly fail) everything after it.
 */
export function gradeDigits(expected: number[], heardDigits: string[]): Grade {
  const exp = expected.map(String);
  const n = exp.length;
  const m = heardDigits.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i;
  for (let j = 1; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = dp[i - 1][j - 1] + (exp[i - 1] === heardDigits[j - 1] ? 0 : 1);
      dp[i][j] = Math.min(sub, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }

  const cells: CellResult[] = new Array(n);
  let extra = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = exp[i - 1] === heardDigits[j - 1];
      if (dp[i][j] === dp[i - 1][j - 1] + (same ? 0 : 1)) {
        cells[i - 1] = {
          expected: expected[i - 1],
          heard: heardDigits[j - 1],
          status: same ? "correct" : "wrong",
        };
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      cells[i - 1] = { expected: expected[i - 1], heard: null, status: "missed" };
      i--;
    } else {
      extra++;
      j--;
    }
  }
  return { cells, extra, heard: heardDigits };
}
