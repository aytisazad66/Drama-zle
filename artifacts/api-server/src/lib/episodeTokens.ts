export interface EpisodeToken {
  num: number;
  token: string;
  tokenType: string;
}

export interface MappedEpisodes {
  episodes: EpisodeToken[];
  totalEpisodes: number;
  missingEpisodeNums: number[];
}

function getEpisodeNum(token: string): number | null {
  const normalized = token
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  const params = new URLSearchParams(normalized);
  const rawNum = params.get("episode") ?? params.get("ep");
  if (!rawNum || !/^\d+$/.test(rawNum)) return null;

  const num = Number(rawNum);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

export function mapEpisodeTokens(
  tokens: string[],
  tokenType: string,
  episodeMarkerCount: number,
): MappedEpisodes {
  const tokenNumbers = tokens.map(getEpisodeNum);
  const explicitNumbers = tokenNumbers.filter(
    (num): num is number => num !== null,
  );
  const expectedFromMarkers = Math.max(0, episodeMarkerCount);
  const plausibleLimit = Math.max(tokens.length, expectedFromMarkers) + 1;
  const canTrustEpisodeNumbers =
    explicitNumbers.length > 0 &&
    explicitNumbers.every((num) => num <= plausibleLimit) &&
    new Set(explicitNumbers).size === explicitNumbers.length;

  const assignedNumbers = new Set<number>(
    canTrustEpisodeNumbers ? explicitNumbers : [],
  );
  const episodes = tokens.map((token, index) => {
    const explicitNum = canTrustEpisodeNumbers ? tokenNumbers[index] : null;
    let num = explicitNum;

    if (num === null) {
      const preferredNum = index + 1;
      if (!assignedNumbers.has(preferredNum)) {
        num = preferredNum;
      } else {
        num = 1;
        while (assignedNumbers.has(num)) num += 1;
      }
      assignedNumbers.add(num);
    }

    return { num, token, tokenType };
  });

  episodes.sort((a, b) => a.num - b.num);
  const totalEpisodes = Math.max(
    tokens.length,
    expectedFromMarkers,
    ...episodes.map((episode) => episode.num),
  );
  const missingEpisodeNums: number[] = [];
  for (let num = 1; num <= totalEpisodes; num += 1) {
    if (!assignedNumbers.has(num)) missingEpisodeNums.push(num);
  }

  return { episodes, totalEpisodes, missingEpisodeNums };
}
