import { Router } from 'express';

const router = Router();

/**
 * POST /api/drama/cf-upload
 *
 * Fetches the video from the source URL and pipes it directly to
 * Cloudflare Stream's direct-upload endpoint.  This avoids the
 * Content-Length / range-request requirement of CF's copy-from-URL API.
 */
router.post('/cf-upload', async (req, res) => {
  const { videoUrl, videoType, name } = req.body as {
    videoUrl?: string;
    videoType?: string;
    name?: string;
  };

  if (!videoUrl || !videoType || !name) {
    return res
      .status(400)
      .json({ error: 'Geçersiz istek: videoUrl, videoType ve name zorunlu' });
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;

  if (!accountId || !token) {
    return res
      .status(500)
      .json({ error: 'Cloudflare kimlik bilgileri yapılandırılmamış' });
  }

  // ── Step 1: fetch the source video ──────────────────────────────────────
  // For HLS videoUrl is already our /stream-video proxy (returns assembled MP4).
  // For MP4 videoUrl is the CDN link — send Referer so the CDN accepts it.
  const sourceHeaders: Record<string, string> =
    videoType === 'mp4'
      ? {
          Referer: 'https://dramadizilerim.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        }
      : {};

  let sourceRes: Response;
  try {
    sourceRes = await fetch(videoUrl, { headers: sourceHeaders });
  } catch (err) {
    return res
      .status(502)
      .json({ error: 'Video kaynağına bağlanılamadı', details: String(err) });
  }

  if (!sourceRes.ok || !sourceRes.body) {
    return res.status(502).json({
      error: 'Video kaynağından veri alınamadı',
      details: `HTTP ${sourceRes.status}`,
    });
  }

  // ── Step 2: pipe directly to CF Stream direct-upload ────────────────────
  // POST /accounts/{id}/stream  — accepts chunked body, no Content-Length needed.
  const nameB64 = Buffer.from(name).toString('base64');

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'video/mp4',
        'Upload-Metadata': `name ${nameB64},requiresignedurls`,
        // Tell CF what we're sending is an MP4 (even from HLS — our proxy assembles it)
      },
      body: sourceRes.body,
      // @ts-ignore — Node 18+ fetch needs duplex for streaming request body
      duplex: 'half',
    },
  );

  if (!cfRes.ok) {
    const errText = await cfRes.text();
    return res
      .status(502)
      .json({ error: 'Cloudflare API hatası', details: errText });
  }

  const data = (await cfRes.json()) as {
    result: {
      uid: string;
      playback: { hls: string; dash: string };
      thumbnail: string;
      status: { state: string };
    };
    success: boolean;
    errors: { message: string }[];
  };

  if (!data.success) {
    return res.status(502).json({
      error: 'CF yükleme başarısız',
      details: data.errors?.map((e) => e.message),
    });
  }

  return res.json({
    uid: data.result.uid,
    hlsUrl: data.result.playback?.hls ?? null,
    dashUrl: data.result.playback?.dash ?? null,
    thumbnailUrl: data.result.thumbnail ?? null,
    state: data.result.status?.state ?? 'queued',
  });
});

export default router;
