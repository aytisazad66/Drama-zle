import { Router, type Request, type Response } from "express";

const router = Router();

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

async function fetchText(url: string): Promise<string> {
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
  return response.text();
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

    res.json({ title, slug, season, totalEpisodes, episodes });
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
    const masterM3u8 = await fetchText(m3u8Url);
    const variants = parseMasterM3u8(masterM3u8);

    if (variants.length === 0) {
      res.status(404).json({ error: "Video kalitesi bulunamadı" });
      return;
    }

    const selected = variants[Math.min(qualityIndex, variants.length - 1)]!;
    const variantM3u8 = await fetchText(selected.url);
    const { initUrl, segments } = parseVariantM3u8(variantM3u8);

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

// --- GET /drama/stream-video?m3u8Url=URL&quality=0 ---
// Streams video: handles both HLS (m3u8 segments) and direct MP4 proxy
router.get("/stream-video", async (req: Request, res: Response) => {
  const { m3u8Url, quality } = req.query;
  if (!m3u8Url || typeof m3u8Url !== "string") {
    res.status(400).json({ error: "m3u8Url gerekli" });
    return;
  }

  const qualityIndex = parseInt((quality as string) ?? "1") || 1;

  try {
    // Direct MP4 — proxy the response straight through
    if (!m3u8Url.includes(".m3u8")) {
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

    // HLS — parse master m3u8 and stream concatenated segments
    const masterM3u8 = await fetchText(m3u8Url);
    const variants = parseMasterM3u8(masterM3u8);

    if (variants.length === 0) {
      res.status(404).json({ error: "Video kalitesi bulunamadı" });
      return;
    }

    const selected = variants[Math.min(qualityIndex, variants.length - 1)]!;
    const variantM3u8 = await fetchText(selected.url);
    const { initUrl, segments } = parseVariantM3u8(variantM3u8);

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

// --- Helpers ---

function parseMasterM3u8(
  text: string,
): { bandwidth: number; url: string; resolution: string }[] {
  const lines = text.split("\n");
  const variants: { bandwidth: number; url: string; resolution: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=(\S+)/);
      const url = lines[i + 1]?.trim();
      if (url && !url.startsWith("#")) {
        variants.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1]!) : 0,
          url,
          resolution: resMatch ? resMatch[1]! : "unknown",
        });
      }
    }
  }

  // Sort highest bandwidth first
  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

function parseVariantM3u8(text: string): {
  initUrl: string | null;
  segments: string[];
} {
  const lines = text.split("\n");
  const segments: string[] = [];
  let initUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("#EXT-X-MAP:URI=")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) initUrl = uriMatch[1]!;
    } else if (line.startsWith("#EXTINF:")) {
      const segUrl = lines[i + 1]?.trim();
      if (segUrl && !segUrl.startsWith("#")) {
        segments.push(segUrl);
      }
    }
  }

  return { initUrl, segments };
}

export default router;
