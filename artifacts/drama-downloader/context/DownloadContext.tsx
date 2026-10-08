import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';

export type DownloadStatus =
  | 'queued'
  | 'extracting'
  | 'uploading'
  | 'done'
  | 'error';

export interface DownloadItem {
  id: string;
  episodeNum: number;
  seriesTitle: string;
  slug: string;
  season: string;
  status: DownloadStatus;
  bytesWritten: number;
  totalBytes: number;
  error?: string;
  token: string;
  tokenType: string;
  episodeUrl?: string;
  addedAt: number;
  /** Cloudflare Stream video UID — set when upload is complete */
  cfStreamUid?: string;
  /** Cloudflare Stream HLS playback URL */
  cfStreamUrl?: string;
}

interface DownloadContextValue {
  downloads: DownloadItem[];
  addEpisodes: (episodes: {
    num: number;
    token: string;
    tokenType: string;
    slug: string;
    season: string;
    title: string;
    episodeUrl?: string;
  }[]) => void;
  cancelDownload: (id: string) => void;
  clearCompleted: () => void;
  clearAll: () => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain || domain === 'REPLACE_WITH_DEPLOYED_API_DOMAIN' || domain === 'undefined') {
    throw new Error('API sunucusu yapılandırılmamış.');
  }
  return `https://${domain}/api/drama`;
}

function makeId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch the video URL via the server proxy, retrying up to maxRetries times
 *  with exponential back-off to survive temporary rate-limiting. */
async function fetchVideoUrlWithRetry(
  apiBase: string,
  token: string,
  type: string,
  episodeUrl?: string,
  maxRetries = 3,
): Promise<{ videoUrl: string | null; videoType: 'hls' | 'mp4'; subtitleUrl: string | null }> {
  const delays = [5000, 15000, 30000]; // ms between attempts
  let lastResult = { videoUrl: null as string | null, videoType: 'mp4' as 'hls' | 'mp4', subtitleUrl: null as string | null };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1] ?? 30000);
    }
    try {
      const serverUrl = `${apiBase}/embed?token=${encodeURIComponent(token)}&tokenType=${encodeURIComponent(type)}${episodeUrl ? `&episodeUrl=${encodeURIComponent(episodeUrl)}` : ''}`;
      const serverRes = await fetch(serverUrl);
      if (serverRes.ok) {
        const data = await serverRes.json() as {
          videoUrl?: string; videoType?: 'hls' | 'mp4';
          subtitleUrl?: string | null; m3u8Url?: string;
        };
        const url = data.videoUrl ?? data.m3u8Url ?? null;
        if (url) {
          return {
            videoUrl: url,
            videoType: data.videoType ?? (url.includes('.m3u8') ? 'hls' : 'mp4'),
            subtitleUrl: data.subtitleUrl ?? null,
          };
        }
      }
    } catch {
      // retry
    }
    lastResult = { videoUrl: null, videoType: 'mp4', subtitleUrl: null };
  }
  return lastResult;
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);

  const isProcessingRef = useRef(false);
  const cancelledRef = useRef<Set<string>>(new Set());
  const downloadsRef = useRef<DownloadItem[]>([]);
  downloadsRef.current = downloads;

  const updateItem = useCallback((id: string, patch: Partial<DownloadItem>) => {
    setDownloads((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
    );
  }, []);

  const processNext = useCallback(async () => {
    if (isProcessingRef.current) return;

    const queued = downloadsRef.current.find((d) => d.status === 'queued');
    if (!queued) {
      isProcessingRef.current = false;
      return;
    }

    isProcessingRef.current = true;
    let stopQueueAfterError = false;
    let queueStopCode: string | undefined;

    try {
      if (cancelledRef.current.has(queued.id)) {
        updateItem(queued.id, { status: 'error', error: 'İptal edildi' });
        isProcessingRef.current = false;
        setTimeout(processNext, 100);
        return;
      }

      // Step 1: Fetch embed page — first collect session cookies from episode page,
      // then use them on the embed request (Cloudflare requires a valid cf_clearance cookie).
      // If direct device fetch fails or returns no m3u8, fall back to server-side /embed.
      updateItem(queued.id, { status: 'extracting' });

      const type = queued.tokenType === 'token' ? 'token' : 'ct';
      // For ct type, queued.token is now the full query string (ct=...&iv=...&video_id=...&episode=...&_t=...&logo=...)
      // For token type, queued.token is just the raw token value
      const embedPageUrl =
        type === 'token'
          ? `https://dramadizilerim.com/embed.php?token=${encodeURIComponent(queued.token)}&v=2`
          : `https://dramadizilerim.com/embed.php?${queued.token}`;

      const MOBILE_UA =
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36';
      const episodeReferer = queued.episodeUrl ?? 'https://dramadizilerim.com/';

      // --- Attempt 1: on-device fetch with session cookie ---
      let embedHtml: string | null = null;
      try {
        // 1a: visit episode page to get Cloudflare session cookie
        let cookieStr = '';
        try {
          const epRes = await fetch(episodeReferer, {
            headers: {
              'User-Agent': MOBILE_UA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
          });
          const rawCookie = epRes.headers.get('set-cookie') ?? '';
          if (rawCookie) {
            // "name=value; attrs, name2=value2; attrs" — split on comma before each new cookie
            cookieStr = rawCookie
              .split(/,\s*(?=[^;]+=[^;,]+)/)
              .map((c) => c.split(';')[0]!.trim())
              .filter(Boolean)
              .join('; ');
          }
        } catch {
          // proceed without cookie
        }

        // 1b: fetch embed page with the collected cookie
        const embedRes = await fetch(embedPageUrl, {
          headers: {
            'User-Agent': MOBILE_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
            'Referer': episodeReferer,
            ...(cookieStr ? { 'Cookie': cookieStr } : {}),
          },
        });

        if (embedRes.ok) {
          const html = await embedRes.text();
          // Accept only if it actually contains a video source (not an Access Denied page)
          if (/m3u8|cfvideo|source\s*=|<source/.test(html)) {
            embedHtml = html;
          }
        }
      } catch {
        // fall through to server-side attempt
      }

      // --- Attempt 2: server-side /embed (has full cookie + header handling) ---
      let videoUrl: string | null = null;
      let videoType: 'hls' | 'mp4' = 'mp4';
      let subtitleUrl: string | null = null;

      if (embedHtml) {
        // Parse from on-device HTML — supports both HLS (m3u8) and direct MP4
        const sourceMatch =
          embedHtml.match(/let source\s*=\s*"(https?:\/\/[^"]{20,})"/) ??
          embedHtml.match(/<source[^>]+src="(https?:\/\/[^"]{20,})"/) ??
          embedHtml.match(/source\s*=\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ??
          embedHtml.match(/"(https:\/\/dizi\.dramadizilerim\.com\/\?url=[^"]+\.m3u8[^"]*)"/);
        videoUrl = sourceMatch?.[1] ?? null;
        videoType = videoUrl?.includes('.m3u8') ? 'hls' : 'mp4';

        // subtitle debug comment may not have .srt extension anymore
        const srtCommentMatch = embedHtml.match(/first subtitle url:\s*(https?:\/\/\S+)/);
        const srtProxyMatch = embedHtml.match(/(https?:\/\/dizi\.dramadizilerim\.com\/\?url=[^\s"]+\.srt)/);
        const captionTokenMatch = embedHtml.match(/window\._captionUrl\s*=\s*"([^"]+)"/);
        subtitleUrl =
          srtCommentMatch?.[1] ??
          srtProxyMatch?.[1] ??
          (captionTokenMatch ? `https://dramadizilerim.com/${captionTokenMatch[1]}` : null);
      }

      if (!videoUrl) {
        // On-device fetch failed or was blocked — try via server proxy with retry
        const fetched = await fetchVideoUrlWithRetry(
          getApiBase(),
          queued.token,
          type,
          queued.episodeUrl,
        );
        videoUrl = fetched.videoUrl;
        videoType = fetched.videoType;
        subtitleUrl = fetched.subtitleUrl;
      }

      if (!videoUrl) {
        throw new Error('Video URL bulunamadı. Site erişimi engelliyor olabilir.');
      }

      if (cancelledRef.current.has(queued.id)) {
        updateItem(queued.id, { status: 'error', error: 'İptal edildi' });
        isProcessingRef.current = false;
        setTimeout(processNext, 100);
        return;
      }

      // Step 2: Upload to Cloudflare Stream
      updateItem(queued.id, { status: 'uploading' });

      const epStr = queued.episodeNum.toString().padStart(2, '0');
      const videoName = `${queued.slug}_S${queued.season}E${epStr}`;

      // Always route through our stream-video proxy so CF can fetch without
      // needing special Referer headers (HLS assembles segments; MP4 proxies).
      const uploadVideoUrl = `${getApiBase()}/stream-video?m3u8Url=${encodeURIComponent(videoUrl)}&quality=1&videoType=${videoType}`;

      const uploadRes = await fetch(`${getApiBase()}/cf-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: uploadVideoUrl,
          name: videoName,
          creator: queued.seriesTitle,
          subtitleUrl: subtitleUrl ?? undefined,
          episodeNum: queued.episodeNum,
          season: queued.season,
        }),
      });

      if (!uploadRes.ok) {
        let errMsg = 'Cloudflare yükleme başarısız';
        try {
          const errData = await uploadRes.json() as {
            error?: string;
            details?: string;
            errorCode?: string;
          };
          if (errData.error) {
            errMsg = errData.details
              ? `${errData.error}: ${errData.details}`
              : errData.error;
          }
          queueStopCode = errData.errorCode;
          stopQueueAfterError = [
            'CF_AUTH',
            'CF_PERMISSION',
            'CF_RATE_LIMIT',
          ].includes(queueStopCode ?? '');
        } catch {}
        throw new Error(errMsg);
      }

      const uploadData = await uploadRes.json() as {
        uid: string;
        hlsUrl: string | null;
        state: string;
      };

      updateItem(queued.id, {
        status: 'done',
        cfStreamUid: uploadData.uid,
        cfStreamUrl: uploadData.hlsUrl ?? undefined,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Bilinmeyen hata';
      if (stopQueueAfterError) {
        const pendingMessage =
          queueStopCode === 'CF_RATE_LIMIT'
            ? 'Cloudflare hız sınırı nedeniyle bu bölüm beklemeye alındı.'
            : 'Cloudflare ayar hatası nedeniyle bu bölüm beklemeye alındı.';
        setDownloads((prev) =>
          prev.map((item) => {
            if (item.id === queued.id) {
              return { ...item, status: 'error', error: message };
            }
            if (item.status === 'queued') {
              return { ...item, status: 'error', error: pendingMessage };
            }
            return item;
          }),
        );
      } else {
        updateItem(queued.id, { status: 'error', error: message });
      }
    }

    isProcessingRef.current = false;
    // 4-second cooldown between episodes to avoid rate-limiting by the video server
    if (!stopQueueAfterError) {
      setTimeout(processNext, 4000);
    }
  }, [updateItem]);

  const addEpisodes = useCallback(
    (
      episodes: {
        num: number;
        token: string;
        tokenType: string;
        slug: string;
        season: string;
        title: string;
        episodeUrl?: string;
      }[]
    ) => {
      const existing = downloadsRef.current;
      const newItems: DownloadItem[] = [];

      for (const ep of episodes) {
        const alreadyQueued = existing.some(
          (d) =>
            d.slug === ep.slug &&
            d.season === ep.season &&
            d.episodeNum === ep.num &&
            d.status !== 'error'
        );
        if (!alreadyQueued) {
          newItems.push({
            id: makeId(),
            episodeNum: ep.num,
            seriesTitle: ep.title,
            slug: ep.slug,
            season: ep.season,
            status: 'queued',
            bytesWritten: 0,
            totalBytes: 0,
            token: ep.token,
            tokenType: ep.tokenType,
            episodeUrl: ep.episodeUrl,
            addedAt: Date.now(),
          });
        }
      }

      if (newItems.length > 0) {
        setDownloads((prev) => [...prev, ...newItems]);
        setTimeout(processNext, 100);
      }
    },
    [processNext]
  );

  const cancelDownload = useCallback(
    (id: string) => {
      cancelledRef.current.add(id);
      updateItem(id, { status: 'error', error: 'İptal edildi' });
    },
    [updateItem]
  );

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d) => d.status !== 'done'));
  }, []);

  const clearAll = useCallback(() => {
    setDownloads([]);
  }, []);

  return (
    <DownloadContext.Provider
      value={{
        downloads,
        addEpisodes,
        cancelDownload,
        clearCompleted,
        clearAll,
      }}
    >
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownloads(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownloads must be used inside DownloadProvider');
  return ctx;
}
