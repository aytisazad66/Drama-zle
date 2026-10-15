const TURKISH_LETTER = /[çğıöşüİÇĞİÖŞÜ]/u;

const ENGLISH_FUNCTION_WORDS = new Set([
  "about",
  "after",
  "and",
  "around",
  "before",
  "between",
  "by",
  "could",
  "down",
  "for",
  "from",
  "how",
  "into",
  "me",
  "my",
  "of",
  "off",
  "only",
  "our",
  "over",
  "should",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "through",
  "to",
  "under",
  "until",
  "up",
  "us",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "with",
  "without",
  "would",
  "you",
  "your",
]);

const TURKISH_ASCII_TITLE_ROOTS = [
  "aile",
  "alfa",
  "anka",
  "araba",
  "asker",
  "av",
  "baba",
  "bana",
  "basbuyucu",
  "beyaz",
  "bir",
  "birlikte",
  "buyu",
  "buyuk",
  "dunya",
  "dugun",
  "duy",
  "edilen",
  "ejder",
  "ejderha",
  "elit",
  "elma",
  "emanet",
  "erkek",
  "es",
  "evcil",
  "evlilik",
  "fedakarlik",
  "firavun",
  "gece",
  "gelen",
  "gelin",
  "gunes",
  "hayat",
  "hayvan",
  "hukumdar",
  "hurda",
  "hurdadan",
  "ilk",
  "ile",
  "intikam",
  "istiyor",
  "kahraman",
  "kamp",
  "kan",
  "kanli",
  "kara",
  "karanlik",
  "kardes",
  "kader",
  "kentsel",
  "kiz",
  "kizim",
  "kolye",
  "krali",
  "kral",
  "kurus",
  "kurt",
  "kucuk",
  "kucumse",
  "kalp",
  "kovdu",
  "masal",
  "maske",
  "melek",
  "mavi",
  "mucize",
  "olmak",
  "olumcul",
  "ogul",
  "oyun",
  "pes",
  "sana",
  "satan",
  "seni",
  "servet",
  "sevda",
  "sistem",
  "sokak",
  "sans",
  "tanri",
  "taht",
  "tek",
  "terk",
  "ugursuz",
  "umut",
  "vadi",
  "ve",
  "yalan",
  "yakut",
  "yasak",
  "yemin",
  "yemek",
  "yeniden",
  "zengin",
  "usta",
  "zalim",
  "zombi",
  "bizi",
] as const;

const MOJIBAKE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["Ã‡", "Ç"],
  ["Ã§", "ç"],
  ["Äž", "Ğ"],
  ["ÄŸ", "ğ"],
  ["Ä°", "İ"],
  ["Ä±", "ı"],
  ["Ã–", "Ö"],
  ["Ã¶", "ö"],
  ["Åž", "Ş"],
  ["ÅŸ", "ş"],
  ["Ãœ", "Ü"],
  ["Ã¼", "ü"],
];

function normalizeTitle(title: string): string[] {
  const normalized = title
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i");

  return normalized.match(/\p{L}+/gu) ?? [];
}

function removeDubLabels(title: string): string {
  return title
    .replace(/^\s*\((?:dublajlı|dubbed|turkish dubbed)\)\s*/iu, "")
    .replace(/\s*\((?:dublajlı|dubbed|turkish dubbed)\)\s*$/iu, "")
    .replace(/\s+(?:dublajlı|dubbed)\s*$/iu, "")
    .trim();
}

function repairCommonTurkishMojibake(title: string): string {
  return MOJIBAKE_REPLACEMENTS.reduce(
    (repaired, [broken, corrected]) => repaired.replaceAll(broken, corrected),
    title,
  );
}

/**
 * Fail closed: an English or ambiguous title is not eligible for automation.
 * Turkish diacritics are strong evidence; ASCII-only titles need two Turkish
 * lexical cues so a single proper name cannot make an English title eligible.
 */
export function isTurkishSeriesTitle(title: string): boolean {
  const cleanedTitle = repairCommonTurkishMojibake(removeDubLabels(title));
  if (!cleanedTitle) return false;

  // Apostrophe-s is common in English possessives; Turkish suffixes use other forms.
  if (/\b[\p{L}]+['’]s\b/iu.test(cleanedTitle)) return false;

  const words = normalizeTitle(cleanedTitle);
  if (words.length === 0) return false;
  if (words.some((word) => ENGLISH_FUNCTION_WORDS.has(word))) return false;

  if (TURKISH_LETTER.test(cleanedTitle)) return true;

  const cueCount = new Set(
    words.filter((word) =>
      TURKISH_ASCII_TITLE_ROOTS.some(
        (root) => word === root || (root.length >= 4 && word.startsWith(root)),
      ),
    ),
  ).size;

  return cueCount >= 2;
}
