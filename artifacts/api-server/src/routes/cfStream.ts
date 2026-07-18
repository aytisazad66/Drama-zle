import { Router } from 'express';

const router = Router();

/**
 * POST /api/drama/cf-upload
 * Kicks off a Cloudflare Stream "copy from URL" job.
 * Returns immediately with the video UID — CF processes asynchronously.
 */
router.post('/cf-upload', async (req, res) => {
  const { videoUrl, videoType, name } = req.body as {
    videoUrl?: string;
    videoType?: string;
    name?: string;
    subtitleUrl?: string | null;
  };

  if (!videoUrl || !videoType || !name) {
    return res.status(400).json({ error: 'Geçersiz istek: videoUrl, videoType ve name zorunlu' });
  }
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;

  if (!accountId || !token) {
    return res.status(500).json({ error: 'Cloudflare kimlik bilgileri yapılandırılmamış' });
  }

  // For MP4 — send Referer + UA so the CDN accepts the request from CF's IP
  // For HLS — videoUrl is already our /stream-video proxy URL which handles headers
  const httpHeaders: Record<string, string> =
    videoType === 'mp4'
      ? {
          Referer: 'https://dramadizilerim.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        }
      : {};

  const body: Record<string, unknown> = {
    url: videoUrl,
    meta: { name },
    requireSignedURLs: false,
    ...(Object.keys(httpHeaders).length ? { httpHeaders } : {}),
  };

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  if (!cfRes.ok) {
    const errText = await cfRes.text();
    return res.status(502).json({ error: 'Cloudflare API hatası', details: errText });
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
    return res
      .status(502)
      .json({ error: 'CF yükleme başarısız', details: data.errors?.map((e) => e.message) });
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
