import { Router, type Request, type Response } from "express";
import {
  GetDramaCatalogQueryParams,
  GetDramaCatalogResponse,
} from "@workspace/api-zod";
import type { DramaCatalogPage } from "@workspace/api-zod";
import { parseMasterM3u8, parseVariantM3u8 } from "./hlsUtils";

const router = Router();
const DRAMA_ORIGIN = "https://dramadizilerim.com";
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const catalogCache = new Map<
  string,
  { expiresAt: number; value: DramaCatalogPage }
>();

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

async function fetchHtml(url: string, referer: string, extraHeaders?: Record<string, string>): Promise<string> {
  const response = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: referer,
      ...extraHeaders,
    },
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}

/** Fetch a page and return both the HTML and the Set-Cookie headers joined */
async function fetchHtmlWithCookies(
  url: string,
  referer: string,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ html: string; cookie: string }> {
  const response = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      Referer: referer,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "Cache-Control": "max-age=0",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    redirect: "follow",
  });
  // Collect all Set-Cookie values
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const newCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!response.ok)
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  return { html: await response.text(), cookie: newCookie };
}

async function fetchTextWithUrl(
  url: string,
): Promise<{ text: string; url: string }> {
  const response = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      Accept: "*/*",
      Referer: "https://dramadizilerim.com/",
      Origin: "https://dramadizilerim.com",
    },
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  return { text: await response.text(), url: response.url || url };
}

async function fetchBinary(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      Referer: "https://dramadizilerim.com/",
    },
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (entity, decimal: string) => {
      const codePoint = Number(decimal);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function readHtmlAttribute(tagAttributes: string, name: string): string | null {
  const match = tagAttributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlEntities(value) : null;
}

function textFromHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseCatalogItems(html: string): DramaCatalogPage["items"] {
  const items: DramaCatalogPage["items"] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    const href = readHtmlAttribute(match[1] ?? "", "href");
    if (!href) continue;

    let seriesUrl: URL;
    try {
      seriesUrl = new URL(href, DRAMA_ORIGIN);
    } catch {
      continue;
    }

    if (seriesUrl.origin !== DRAMA_ORIGIN) continue;
    const slugMatch = seriesUrl.pathname.match(/^\/dizi\/([^/]+)\/?$/);
    if (!slugMatch) continue;

    const slug = slugMatch[1]!;
    const canonicalUrl = new URL(`/dizi/${slug}`, DRAMA_ORIGIN).toString();
    if (seen.has(canonicalUrl)) continue;

    const contents = match[2] ?? "";
    const heading = contents.match(
      /<h[1-6]\b[^>]*class=["'][^"']*\bvideo-(?:item-)?title\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]\s*>/i,
    )?.[1];
    const imageTag = contents.match(/<img\b[^>]*>/i)?.[0];
    const imageAlt = imageTag
      ? readHtmlAttribute(imageTag, "alt")
      : null;
    const anchorTitle = readHtmlAttribute(match[1] ?? "", "title");
    const title = textFromHtml(heading ?? anchorTitle ?? imageAlt ?? "")
      .replace(/\s+(?:poster|izle)$/i, "")
      .trim();
    if (!title) continue;

    const posterSource = imageTag
      ? readHtmlAttribute(imageTag, "src") ??
        readHtmlAttribute(imageTag, "data-src") ??
        readHtmlAttribute(imageTag, "data-lazy-src")
      : null;
    let posterUrl: string | null = null;
    if (posterSource) {
      try {
        const parsedPoster = new URL(posterSource, DRAMA_ORIGIN);
        if (parsedPoster.protocol === "https:") {
          posterUrl = parsedPoster.toString();
        }
      } catch {
        // An invalid poster does not make the series entry unusable.
      }
    }

    seen.add(canonicalUrl);
    items.push({ title, url: canonicalUrl, posterUrl });
  }

  return items;
}

async function fetchCatalogHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      ...BASE_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: `${DRAMA_ORIGIN}/dizi`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Catalog source returned HTTP ${response.status}`);
  }
  return response.text();
}

function findFirstEpisodeUrl(html: string): URL | null {
  const anchorRegex = /<a\b([^>]*)>/gi;
  let firstEpisode: URL | null = null;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    const href = readHtmlAttribute(match[1] ?? "", "href");
    if (!href) continue;

    try {
      const candidate = new URL(href, DRAMA_ORIGIN);
      if (
        candidate.origin !== DRAMA_ORIGIN ||
        !/^\/izle\/[^/]+\/?$/.test(candidate.pathname)
      ) {
        continue;
      }

      if (candidate.searchParams.get("e") === "1") return candidate;
      firstEpisode ??= candidate;
    } catch {
      // Ignore malformed links in the source page.
    }
  }

  return firstEpisode;
}

// --- GET /drama/catalog?q=<title>&page=<page> ---
router.get("/catalog", async (req: Request, res: Response) => {
  const parsedQuery = GetDramaCatalogQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: "Geçersiz katalog araması" });
    return;
  }

  const query = parsedQuery.data.q?.trim() ?? "";
  const page = parsedQuery.data.page ?? 1;
  if (!Number.isInteger(page)) {
    res.status(400).json({ error: "Sayfa numarası tam sayı olmalı" });
    return;
  }

  const cacheKey = `${query.toLocaleLowerCase("tr-TR")}:${page}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.value);
    return;
  }
  if (cached) catalogCache.delete(cacheKey);

  try {
    const sourceUrl = new URL(query ? "/search" : "/dizi", DRAMA_ORIGIN);
    if (query) sourceUrl.searchParams.set("q", query);
    sourceUrl.searchParams.set("page", String(page));

    const html = await fetchCatalogHtml(sourceUrl.toString());
    const payload = GetDramaCatalogResponse.parse({
      items: parseCatalogItems(html),
      page,
      hasMore:
        /<a\b[^>]*\brel=["'][^"']*\bnext\b[^"']*["'][^>]*>/i.test(html),
    });

    catalogCache.set(cacheKey, {
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
      value: payload,
    });
    if (catalogCache.size > 100) {
      const oldestKey = catalogCache.keys().next().value;
      if (oldestKey) catalogCache.delete(oldestKey);
    }

    res.json(payload);
  } catch (err) {
    req.log.error(
      { err, page, hasSearch: Boolean(query) },
      "drama catalog fetch failed",
    );
    res.status(502).json({ error: "Dizi kataloğu şu anda alınamıyor" });
  }
});

// --- GET /drama/seasons?url=<series_page_url> ---
// Lists every season page linked from a series detail page.
router.get("/seasons", async (req: Request, res: Response) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url parametresi gerekli" });
    return;
  }

  try {
    const seriesUrl = new URL(url);
    if (
      seriesUrl.protocol !== "https:" ||
      !["dramadizilerim.com", "www.dramadizilerim.com"].includes(
        seriesUrl.hostname.toLowerCase(),
      ) ||
      !/^\/dizi\/[^/]+\/?$/.test(seriesUrl.pathname)
    ) {
      res.status(400).json({ error: "Geçerli bir dizi sayfası gerekli" });
      return;
    }

    const slug = seriesUrl.pathname.split("/").filter(Boolean).at(-1);
    if (!slug) {
      res.status(400).json({ error: "Dizi bağlantısı tanınamadı" });
      return;
    }

    const html = await fetchHtml(seriesUrl.toString(), `${DRAMA_ORIGIN}/dizi`);
    const seasonPages = new Map<string, string>();
    const anchorRegex = /<a\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) !== null) {
      const href = readHtmlAttribute(match[1] ?? "", "href");
      if (!href) continue;

      try {
        const candidate = new URL(href, DRAMA_ORIGIN);
        if (
          !["dramadizilerim.com", "www.dramadizilerim.com"].includes(
            candidate.hostname.toLowerCase(),
          ) ||
          candidate.pathname.replace(/\/$/, "") !== `/izle/${slug}`
        ) {
          continue;
        }
        const season = candidate.searchParams.get("s") ?? "1";
        if (!/^\d+$/.test(season)) continue;
        candidate.searchParams.set("s", season);
        candidate.searchParams.set("e", "1");
        seasonPages.set(
          season,
          new URL(`/izle/${slug}?${candidate.searchParams.toString()}`, DRAMA_ORIGIN).toString(),
        );
      } catch {
        // Ignore malformed season links.
      }
    }

    if (seasonPages.size === 0) {
      const firstEpisode = findFirstEpisodeUrl(html);
      const season = firstEpisode?.searchParams.get("s") ?? "1";
      const fallback = new URL(`/izle/${slug}`, DRAMA_ORIGIN);
      fallback.searchParams.set("s", season);
      fallback.searchParams.set("e", "1");
      seasonPages.set(season, fallback.toString());
    }

    res.json({
      seasons: [...seasonPages.entries()]
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([season, episodeUrl]) => ({ season, episodeUrl })),
    });
  } catch (err) {
    req.log.error({ err }, "season list fetch failed");
    res.status(502).json({ error: "Dizi sezonları şu anda alınamıyor" });
  }
});

// --- GET /drama/extract?url=<episode_page_url> ---
// Returns list of all episodes (token + episode number) from the season page
router.get("/extract", async (req: Request, res: Response) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url parametresi gerekli" });
    return;
  }

  try {
    const pageUrl = new URL(url);
    if (
      pageUrl.protocol !== "https:" ||
      !["dramadizilerim.com", "www.dramadizilerim.com"].includes(
        pageUrl.hostname.toLowerCase(),
      )
    ) {
      res.status(400).json({ error: "Yalnızca DramaDizilerim bağlantıları desteklenir" });
      return;
    }

    if (/^\/dizi\/[^/]+\/?$/.test(pageUrl.pathname)) {
      const detailHtml = await fetchHtml(
        pageUrl.toString(),
        `${DRAMA_ORIGIN}/dizi`,
      );
      const firstEpisodeUrl = findFirstEpisodeUrl(detailHtml);
      if (firstEpisodeUrl) {
        pageUrl.href = firstEpisodeUrl.href;
      } else {
        const slug = pageUrl.pathname.split("/").filter(Boolean).at(-1);
        if (!slug) {
          res.status(400).json({ error: "Dizi bağlantısı tanınamadı" });
          return;
        }
        pageUrl.pathname = `/izle/${slug}`;
        pageUrl.search = "?s=1&e=1";
      }
    }

    if (!/^\/izle\/[^/]+\/?$/.test(pageUrl.pathname)) {
      res.status(400).json({ error: "Dizi bağlantısı tanınamadı" });
      return;
    }

    // Always load from e=1 to get all episodes listed on the page
    pageUrl.searchParams.set("e", "1");
    const slug = pageUrl.pathname.replace("/izle/", "").replace(/\/$/, "");
    const season = pageUrl.searchParams.get("s") ?? "1";

    const html = await fetchHtml(
      pageUrl.toString(),
      `https://dramadizilerim.com/dizi/${slug}`,
    );

    // Extract title — strip " | DramaDizilerim", episode/season suffixes
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
    const title = titleMatch
      ? titleMatch[1]
          .replace(/\s*\|.*$/, "")              // strip "| DramaDizilerim"
          .replace(/\s*-\s*DramaDizilerim.*/i, "")
          .replace(/\s+\d+\.\s*(?:Bölüm|Episode)\b.*/i, "")
          .replace(/\s+(Sezon|Season)\s+\d+.*/i, "")
          .replace(/\s+Bölüm\s+\d+.*/i, "")
          .replace(/\s+izle\s*/i, "")
          .trim()
      : slug;

    // Collect full embed query strings in DOM order (ct=TOKEN&iv=IV&video_id=ID&episode=EP&_t=TS&logo=LOGO)
    // We capture the full query string so the embed page gets all required params.
    const ctQueryStrings: string[] = [];
    const seen = new Set<string>();
    const allCtRe = /embed\.php\?([^"'<>\s\n\r]+)/g;
    let m: RegExpExecArray | null;
    while ((m = allCtRe.exec(html)) !== null) {
      const qs = m[1]!;
      if (qs.startsWith("ct=") && !seen.has(qs)) {
        seen.add(qs);
        ctQueryStrings.push(qs);
      }
    }

    // Fallback: data-token="TOKEN" (embed.php?token=TOKEN&v=2)
    const dataTokens: string[] = [];
    if (ctQueryStrings.length === 0) {
      const tokenRe = /data-token="([^"]+)"/g;
      while ((m = tokenRe.exec(html)) !== null) {
        dataTokens.push(m[1]!);
      }
    }

    // token field now holds the full query string for ct type, or raw token value for token type
    const tokens = ctQueryStrings.length > 0 ? ctQueryStrings : dataTokens;
    const tokenType = ctQueryStrings.length > 0 ? "ct" : "token";

    // Count total episodes from data-epid markers
    const epIdCount = (html.match(/data-epid="[^"]+"/g) ?? []).length;
    const totalEpisodes = Math.max(tokens.length, epIdCount);

    const episodes = tokens.map((token, i) => ({
      num: i + 1,
      token,
      tokenType,
    }));

    res.json({
      title,
      slug,
      season,
      totalEpisodes,
      episodes,
      episodeUrl: pageUrl.toString(),
    });
  } catch (err) {
    req.log.error({ err, url }, "extract failed");
    res.status(500).json({ error: "Sayfa okunamadı" });
  }
});

// --- GET /drama/embed?token=TOKEN&tokenType=ct|token&episodeUrl=URL ---
// Returns m3u8 URL + subtitle URL from the embed page
router.get("/embed", async (req: Request, res: Response) => {
  const { token, tokenType, episodeUrl } = req.query;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token parametresi gerekli" });
    return;
  }

  try {
    const type = tokenType === "token" ? "token" : "ct";
    // For ct type, token now holds the full query string (ct=...&iv=...&video_id=...&episode=...&_t=...&logo=...)
    // For token type, token is just the raw token value
    const embedUrl =
      type === "token"
        ? `https://dramadizilerim.com/embed.php?token=${encodeURIComponent(token)}&v=2`
        : `https://dramadizilerim.com/embed.php?${token}`;

    // Step 1: visit the episode page first to obtain session cookies
    const refererPage = typeof episodeUrl === "string" && episodeUrl
      ? episodeUrl
      : "https://dramadizilerim.com/";
    let cookie = "";
    try {
      const { cookie: pageCookie } = await fetchHtmlWithCookies(refererPage, "https://dramadizilerim.com/");
      cookie = pageCookie;
    } catch {
      // continue without cookie — better than failing outright
    }

    // Step 2: fetch embed page with the cookies we collected
    const { html } = await fetchHtmlWithCookies(embedUrl, refererPage, cookie || undefined);

    // Extract video source — supports both HLS (m3u8) and direct MP4 (cfvideo.netshort.com)
    const sourceMatch =
      // "let source = "URL"" — primary pattern, matches both m3u8 and mp4
      html.match(/let source\s*=\s*"(https?:\/\/[^"]{20,})"/) ??
      // <source src="URL"> — fallback HTML tag
      html.match(/<source[^>]+src="(https?:\/\/[^"]{20,})"/) ??
      // Legacy patterns
      html.match(/source\s*=\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ??
      html.match(/"(https:\/\/dizi\.dramadizilerim\.com\/\?url=[^"]+\.m3u8[^"]*)"/);

    const videoUrl = sourceMatch ? sourceMatch[1]! : null;
    const videoType = videoUrl?.includes(".m3u8") ? "hls" : "mp4";

    // Extract subtitle — debug comment contains direct URL (may not have .srt extension)
    const srtCommentMatch = html.match(
      /first subtitle url:\s*(https?:\/\/\S+)/,
    );
    const srtProxyMatch = html.match(
      /(https?:\/\/dizi\.dramadizilerim\.com\/\?url=[^\s"]+\.srt)/,
    );
    const captionTokenMatch = html.match(
      /window\._captionUrl\s*=\s*"([^"]+)"/,
    );

    const subtitleUrl =
      srtCommentMatch?.[1] ??
      srtProxyMatch?.[1] ??
      (captionTokenMatch
        ? `https://dramadizilerim.com/${captionTokenMatch[1]}`
        : null);

    if (!videoUrl) {
      res.status(404).json({ error: "Video URL bulunamadı", html: html.slice(0, 500) });
      return;
    }

    // Keep m3u8Url field for backward compat, add videoType
    res.json({ m3u8Url: videoUrl, videoUrl, videoType, subtitleUrl, hasSubtitle: !!subtitleUrl });
  } catch (err) {
    req.log.error({ err, token }, "embed extraction failed");
    res.status(500).json({ error: "Embed sayfası okunamadı" });
  }
});

// --- GET /drama/segments?m3u8Url=URL&quality=0 ---
// Parses master m3u8 and returns init URL + segment URL list
router.get("/segments", async (req: Request, res: Response) => {
  const { m3u8Url, quality } = req.query;
  if (!m3u8Url || typeof m3u8Url !== "string") {
    res.status(400).json({ error: "m3u8Url gerekli" });
    return;
  }

  const qualityIndex = parseInt((quality as string) ?? "0") || 0;

  try {
    const masterPlaylist = await fetchTextWithUrl(m3u8Url);
    const variants = parseMasterM3u8(
      masterPlaylist.text,
      masterPlaylist.url,
    );

    if (variants.length === 0) {
      res.status(404).json({ error: "Video kalitesi bulunamadı" });
      return;
    }

    const selected = variants[Math.min(qualityIndex, variants.length - 1)]!;
    const variantPlaylist = await fetchTextWithUrl(selected.url);
    const { initUrl, segments } = parseVariantM3u8(
      variantPlaylist.text,
      variantPlaylist.url,
    );

    res.json({
      initUrl,
      segments,
      segmentCount: segments.length,
      selectedBandwidth: selected.bandwidth,
      availableQualities: variants.map((v, i) => ({
        index: i,
        bandwidth: v.bandwidth,
        resolution: v.resolution,
      })),
    });
  } catch (err) {
    req.log.error({ err, m3u8Url }, "segments failed");
    res.status(500).json({ error: "M3U8 okunamadı" });
  }
});

// --- GET /drama/stream-video?m3u8Url=URL&quality=0&videoType=hls|mp4 ---
// Streams video: handles both HLS (m3u8 segments) and direct MP4 proxy.
// videoType param overrides URL-based detection (needed for hls_proxy.php URLs).
router.get("/stream-video", async (req: Request, res: Response) => {
  const { m3u8Url, quality, videoType } = req.query;
  if (!m3u8Url || typeof m3u8Url !== "string") {
    res.status(400).json({ error: "m3u8Url gerekli" });
    return;
  }

  const qualityIndex = parseInt((quality as string) ?? "1") || 1;

  // Determine mode: prefer explicit videoType param; fall back to URL heuristic
  const isHls = videoType === "hls" || m3u8Url.includes(".m3u8");

  try {
    if (!isHls) {
      // Direct MP4 — proxy the response straight through
      const response = await fetch(m3u8Url, {
        headers: {
          ...BASE_HEADERS,
          Referer: "https://dramadizilerim.com/",
        },
      });
      if (!response.ok) {
        res.status(502).json({ error: `Video alınamadı: HTTP ${response.status}` });
        return;
      }
      res.setHeader("Content-Type", response.headers.get("content-type") ?? "video/mp4");
      const cl = response.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Access-Control-Allow-Origin", "*");
      const reader = response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done || res.writableEnded) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }

    // HLS — fetch the playlist and determine if it is a master or variant m3u8
    const playlist = await fetchTextWithUrl(m3u8Url);
    const variants = parseMasterM3u8(playlist.text, playlist.url);

    let variantPlaylistText = playlist.text;
    let variantPlaylistUrl = playlist.url;
    if (variants.length > 0) {
      // Master m3u8: pick the requested quality variant
      const selected = variants[Math.min(qualityIndex, variants.length - 1)]!;
      const variantPlaylist = await fetchTextWithUrl(selected.url);
      variantPlaylistUrl = variantPlaylist.url;
      variantPlaylistText = variantPlaylist.text;
    } else if (playlist.text.includes("#EXTINF:")) {
      // Already a variant (media) m3u8 — use it directly
      variantPlaylistText = playlist.text;
    } else {
      res.status(404).json({ error: "Video kalitesi bulunamadı" });
      return;
    }

    const { initUrl, segments } = parseVariantM3u8(
      variantPlaylistText,
      variantPlaylistUrl,
    );

    if (segments.length === 0) {
      res.status(404).json({ error: "Video segmentleri bulunamadı" });
      return;
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Segment-Count", String(segments.length));
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (initUrl) {
      try {
        const initData = await fetchBinary(initUrl);
        if (!res.writableEnded) res.write(initData);
      } catch (e) {
        req.log.warn({ e }, "init segment failed");
      }
    }

    for (const segUrl of segments) {
      if (res.writableEnded) break;
      try {
        const segData = await fetchBinary(segUrl);
        res.write(segData);
      } catch (e) {
        req.log.warn({ e, segUrl }, "segment failed, skipping");
      }
    }

    res.end();
  } catch (err) {
    req.log.error({ err, m3u8Url }, "stream-video failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Video akışı başarısız" });
    } else {
      res.end();
    }
  }
});

// --- GET /drama/subtitle?url=URL ---
// Proxies SRT/VTT subtitle file
router.get("/subtitle", async (req: Request, res: Response) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url gerekli" });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: {
        ...BASE_HEADERS,
        Referer: "https://dramadizilerim.com/",
      },
    });
    const text = await response.text();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    req.log.error({ err, url }, "subtitle fetch failed");
    res.status(500).json({ error: "Altyazı indirilemedi" });
  }
});

export default router;
