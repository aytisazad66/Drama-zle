import { Router } from 'express';
import { URL } from 'url';
import { parseMasterM3u8, parseVariantM3u8 } from './hlsUtils';

const router = Router();

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://dramadizilerim.com/',
  Origin: 'https://dramadizilerim.com',
};

const MAX_UPSTREAM_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proxyFetchResponse(url: string, accept: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { ...BASE_HEADERS, Accept: accept },
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) return response;

      const error = new Error(`HTTP ${response.status} fetching ${url}`);
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      if (!retryable || attempt === MAX_UPSTREAM_ATTEMPTS - 1) throw error;
      lastError = error;
    } catch (error) {
      if (attempt === MAX_UPSTREAM_ATTEMPTS - 1) throw error;
      lastError = error;
    }

    await sleep(350 * (attempt + 1));
  }

  throw lastError instanceof Error ? lastError : new Error('HLS upstream request failed');
}

async function proxyFetchBuffer(url: string): Promise<Buffer> {
  const res = await proxyFetchResponse(url, '*/*');
  return Buffer.from(await res.arrayBuffer());
}

async function proxyFetchText(url: string): Promise<string> {
  const res = await proxyFetchResponse(url, '*/*');
  return res.text();
}

async function proxyFetchPlaylist(
  url: string,
): Promise<{ text: string; url: string }> {
  const response = await proxyFetchResponse(url, '*/*');
  return { text: await response.text(), url: response.url || url };
}

/** Download all HLS segments and concatenate into a single MP4 buffer. */
async function assembleHls(m3u8Url: string, qualityIndex: number): Promise<Buffer> {
  const masterPlaylist = await proxyFetchPlaylist(m3u8Url);
  const variants = parseMasterM3u8(masterPlaylist.text, masterPlaylist.url);

  let variantText = masterPlaylist.text;
  let variantUrl = masterPlaylist.url;
  if (variants.length > 0) {
    const selected = variants[Math.min(qualityIndex, variants.length - 1)]!;
    const variantPlaylist = await proxyFetchPlaylist(selected.url);
    variantUrl = variantPlaylist.url;
    variantText = variantPlaylist.text;
  } else if (masterPlaylist.text.includes('#EXTINF:')) {
    variantText = masterPlaylist.text;
  } else {
    throw new Error('HLS playlist içinde video segmenti bulunamadı');
  }

  if (/#EXT-X-KEY:\s*METHOD=(?!NONE\b)/i.test(variantText)) {
    throw new Error('Şifreli HLS akışı desteklenmiyor');
  }

  const { initUrl, segments } = parseVariantM3u8(variantText, variantUrl);
  if (segments.length === 0) {
    throw new Error('HLS playlist içinde indirilebilir segment bulunamadı');
  }

  const chunks: Buffer[] = [];

  if (initUrl) {
    try {
      chunks.push(await proxyFetchBuffer(initUrl));
    } catch (error) {
      throw new Error(
        `HLS başlangıç segmenti alınamadı: ${safeErrorMessage(error)}`,
      );
    }
  }
  for (let index = 0; index < segments.length; index++) {
    try {
      chunks.push(await proxyFetchBuffer(segments[index]!));
    } catch (error) {
      throw new Error(
        `HLS segmenti ${index + 1}/${segments.length} alınamadı: ${safeErrorMessage(error)}`,
      );
    }
  }

  if (chunks.length === 0) throw new Error('Hiç HLS segmenti indirilemedi');
  return Buffer.concat(chunks);
}

/**
 * Set creator on a CF Stream video after upload.
 * Must be done as a separate request — multipart direct-upload ignores the creator form field.
 */
async function setCfMeta(
  accountId: string,
  token: string,
  uid: string,
  fields: {
    name?: string;
    creator?: string;
    episodeNum?: number;
    season?: string;
    automationKey?: string;
  },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (fields.creator) body.creator = fields.creator;
  // Always set meta so name is never lost
  body.meta = {
    ...(fields.name && { name: fields.name }),
    ...(fields.episodeNum !== undefined && { episode: String(fields.episodeNum) }),
    ...(fields.season !== undefined && { season: fields.season }),
    ...(fields.automationKey && { automationKey: fields.automationKey }),
  };

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CF meta set failed (${res.status}): ${err}`);
  }
}

/**
 * Upload a subtitle file to CF Stream as a caption track.
 * Non-fatal — failure is logged but does not fail the video upload.
 *
 * CF API: PUT /accounts/{id}/stream/{uid}/captions/{language}
 * Body: multipart/form-data with field "file" = SRT/VTT content.
 */
async function uploadCaption(
  accountId: string,
  token: string,
  uid: string,
  subtitleUrl: string,
  language = 'tr',
): Promise<void> {
  const subtitleText = await proxyFetchText(subtitleUrl);

  // Detect format: VTT starts with "WEBVTT", otherwise treat as SRT
  const isVtt = subtitleText.trimStart().startsWith('WEBVTT');
  const mimeType = isVtt ? 'text/vtt' : 'application/x-subrip';
  const ext = isVtt ? 'vtt' : 'srt';

  const form = new FormData();
  form.append(
    'file',
    new Blob([subtitleText], { type: mimeType }),
    `caption_${language}.${ext}`,
  );

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}/captions/${language}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`CF caption upload failed (${res.status}): ${errText}`);
  }
}

/** Parse the CF Stream result shape (shared by both upload paths). */
function parseCfResult(data: {
  result: {
    uid: string;
    playback?: { hls?: string; dash?: string };
    thumbnail?: string;
    status?: { state?: string };
  };
  success: boolean;
  errors?: { message: string }[];
}) {
  return {
    uid: data.result.uid,
    hlsUrl: data.result.playback?.hls ?? null,
    dashUrl: data.result.playback?.dash ?? null,
    thumbnailUrl: data.result.thumbnail ?? null,
    state: data.result.status?.state ?? 'queued',
  };
}

function getCfUploadError(status: number, responseBody: string): {
  error: string;
  errorCode: 'CF_AUTH' | 'CF_PERMISSION' | 'CF_RATE_LIMIT' | 'CF_API_ERROR';
} {
  let codes: number[] = [];
  try {
    const body = JSON.parse(responseBody) as {
      errors?: { code?: number }[];
    };
    codes = body.errors?.flatMap((item) =>
      typeof item.code === 'number' ? [item.code] : [],
    ) ?? [];
  } catch {
    // Keep the HTTP status as the fallback classification.
  }

  if (status === 401 || codes.includes(10000)) {
    return {
      error:
        'Cloudflare tokenı doğrulanamadı. CF_STREAM_TOKEN değerini ve tokenın doğru Cloudflare hesabına ait olduğunu kontrol edin.',
      errorCode: 'CF_AUTH',
    };
  }
  if (status === 403) {
    return {
      error:
        'Cloudflare tokenında Stream Write izni yok. Token izinlerini kontrol edin.',
      errorCode: 'CF_PERMISSION',
    };
  }
  if (status === 429 || codes.includes(10429)) {
    return {
      error:
        'Cloudflare istek sınırı aşıldı. Bir süre bekleyin; indirme kuyruğu durduruldu.',
      errorCode: 'CF_RATE_LIMIT',
    };
  }

  return {
    error: `Cloudflare API isteği başarısız oldu (HTTP ${status}).`,
    errorCode: 'CF_API_ERROR',
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/https?:\/\/\S+/g, '[source URL]');
}

/**
 * POST /api/drama/cf-upload
 *
 * Uploads a video to Cloudflare Stream, then (optionally) attaches a caption track.
 *
 * - HLS: buffers all segments on our server → direct multipart upload to CF
 *   (copy-from-URL fails for HLS because CF can't determine stream size from
 *   our chunked endpoint).
 * - MP4: copy-from-URL for the mobile app; automation can use direct server-side
 *   proxying when the source requires request headers.
 *
 * Body fields:
 *   videoUrl   — our /stream-video proxy URL
 *   name       — video identifier (e.g. "sen-bana-aitsin_S1E01")
 *   creator    — series title for CF grouping (e.g. "Sen Bana Aitsin")
 *   subtitleUrl — (optional) direct SRT/VTT URL; uploaded as Turkish caption
 */
router.post('/cf-upload', async (req, res) => {
  const { videoUrl, name, creator, subtitleUrl, episodeNum, season, automationKey, directSource, videoType: requestedVideoType } = req.body as {
    videoUrl?: string;
    name?: string;
    creator?: string;
    subtitleUrl?: string;
    episodeNum?: number;
    season?: string;
    automationKey?: string;
    directSource?: boolean;
    videoType?: "hls" | "mp4";
  };

  if (!videoUrl || !name) {
    return res.status(400).json({ error: 'Geçersiz istek: videoUrl ve name zorunlu' });
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;
  if (!accountId || !token) {
    return res.status(500).json({ error: 'Cloudflare kimlik bilgileri yapılandırılmamış' });
  }

  // Parse the stream-video proxy URL to extract original params
  let m3u8Url: string = videoUrl;
  let videoType: string = 'mp4';
  let qualityIndex = 1;

  if (directSource) {
    m3u8Url = videoUrl;
    videoType = requestedVideoType ?? (videoUrl.includes(".m3u8") ? "hls" : "mp4");
  } else {
    try {
      const parsed = new URL(videoUrl);
      m3u8Url = parsed.searchParams.get('m3u8Url') ?? videoUrl;
      videoType = parsed.searchParams.get('videoType') ?? 'mp4';
      qualityIndex = parseInt(parsed.searchParams.get('quality') ?? '1') || 1;
    } catch {
      // videoUrl is already a direct URL — use as-is
    }
  }

  const isHls = videoType === 'hls' || m3u8Url.includes('.m3u8');
  const serverProxySource = directSource === true;

  // Helper: upload caption after we have the uid, non-fatal
  async function maybeUploadCaption(uid: string) {
    if (!subtitleUrl) return;
    try {
      await uploadCaption(accountId!, token!, uid, subtitleUrl);
      req.log.info({ uid, subtitleUrl }, 'CF caption uploaded');
    } catch (err) {
      req.log.warn({ err, uid, subtitleUrl }, 'CF caption upload failed (non-fatal)');
    }
  }

  // ── HLS: assemble segments locally, direct multipart upload ────────────────
  if (isHls || serverProxySource) {
    const sourceHost = (() => {
      try {
        return new URL(m3u8Url).host;
      } catch {
        return undefined;
      }
    })();
    req.log.info(
      { sourceHost, qualityIndex, name, isHls },
      isHls ? 'CF upload: assembling HLS' : 'CF upload: proxying MP4 source',
    );

    let videoBuffer: Buffer;
    try {
      videoBuffer = isHls
        ? await assembleHls(m3u8Url, qualityIndex)
        : await proxyFetchBuffer(m3u8Url);
    } catch (err) {
      const details = safeErrorMessage(err);
      req.log.error(
        { error: details, sourceHost },
        isHls ? 'HLS assembly failed' : 'MP4 source fetch failed',
      );
      return res.status(502).json({
        error: isHls ? 'HLS video indirilemedi' : 'MP4 video indirilemedi',
        details,
      });
    }

    req.log.info({ bytes: videoBuffer.length, name }, 'HLS assembled, uploading to CF');

    const formData = new FormData();
    // Copy into an ArrayBuffer-backed view so TypeScript's Web Blob types
    // accept the Node Buffer without changing the uploaded bytes.
    const videoBytes = new Uint8Array(new ArrayBuffer(videoBuffer.byteLength));
    videoBytes.set(videoBuffer);
    formData.append('file', new Blob([videoBytes], { type: 'video/mp4' }), `${name}.mp4`);
    if (creator) formData.append('creator', creator);

    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );

    if (!cfRes.ok) {
      const errText = await cfRes.text();
      req.log.error({ cfStatus: cfRes.status, cfBody: errText, name }, 'CF HLS upload failed');
      return res.status(502).json(getCfUploadError(cfRes.status, errText));
    }

    const data = await cfRes.json() as { result: any; success: boolean; errors?: { message: string }[] };
    if (!data.success) {
      return res.status(502).json({ error: 'CF yükleme başarısız', details: data.errors?.map((e) => e.message) });
    }

    const result = parseCfResult(data);
    if (creator) {
      try { await setCfMeta(accountId!, token!, result.uid, { name, creator, episodeNum, season, automationKey }); }
      catch (err) { req.log.warn({ err, uid: result.uid }, 'CF meta set failed (non-fatal)'); }
    }
    await maybeUploadCaption(result.uid);
    return res.json(result);
  }

  // ── MP4: copy-from-URL (CF fetches from our stream-video proxy) ──
  req.log.info({ name }, 'CF upload: copy-from-URL (MP4)');

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl, meta: { name }, creator: creator ?? '' }),
    },
  );

  if (!cfRes.ok) {
    const errText = await cfRes.text();
    req.log.error({ cfStatus: cfRes.status, cfBody: errText, name }, 'CF MP4 copy failed');
    return res.status(502).json(getCfUploadError(cfRes.status, errText));
  }

  const data = await cfRes.json() as { result: any; success: boolean; errors?: { message: string }[] };
  if (!data.success) {
    return res.status(502).json({ error: 'CF yükleme başarısız', details: data.errors?.map((e) => e.message) });
  }

  const result = parseCfResult(data);
  if (creator) {
    try { await setCfMeta(accountId!, token!, result.uid, { name, creator, episodeNum, season, automationKey }); }
    catch (err) { req.log.warn({ err, uid: result.uid }, 'CF meta set failed (non-fatal)'); }
  }
  await maybeUploadCaption(result.uid);
  return res.json(result);
});

export default router;
