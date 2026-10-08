export interface HlsVariant {
  bandwidth: number;
  url: string;
  resolution: string;
}

export interface HlsMediaPlaylist {
  initUrl: string | null;
  segments: string[];
}

function playlistLines(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
}

function resolvePlaylistUri(uri: string, baseUrl: string): string | null {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

export function parseMasterM3u8(text: string, playlistUrl: string): HlsVariant[] {
  const lines = playlistLines(text);
  const variants: HlsVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const streamInfo = lines[i]!.match(/^#EXT-X-STREAM-INF:(.*)$/i);
    if (!streamInfo) continue;

    const attributes = streamInfo[1] ?? "";
    const bandwidth = Number(attributes.match(/\bBANDWIDTH=(\d+)/i)?.[1] ?? 0);
    const resolution = attributes.match(/\bRESOLUTION=([^,\s]+)/i)?.[1] ?? "unknown";

    for (let uriIndex = i + 1; uriIndex < lines.length; uriIndex++) {
      const uri = lines[uriIndex]!;
      if (!uri) continue;
      if (uri.startsWith("#")) {
        if (/^#EXT-X-STREAM-INF:/i.test(uri)) break;
        continue;
      }

      const resolvedUrl = resolvePlaylistUri(uri, playlistUrl);
      if (resolvedUrl) variants.push({ bandwidth, url: resolvedUrl, resolution });
      i = uriIndex;
      break;
    }
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

function readTagUri(line: string): string | null {
  const match = line.match(
    /(?:^|[:,])\s*URI\s*=\s*(?:"([^"]+)"|'([^']+)'|([^,\s]+))/i,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function parseVariantM3u8(
  text: string,
  playlistUrl: string,
): HlsMediaPlaylist {
  const lines = playlistLines(text);
  const segments: string[] = [];
  let initUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#EXT-X-MAP:/i.test(line)) {
      const uri = readTagUri(line);
      initUrl = uri ? resolvePlaylistUri(uri, playlistUrl) : null;
    } else if (/^#EXTINF:/i.test(line)) {
      for (let uriIndex = i + 1; uriIndex < lines.length; uriIndex++) {
        const uri = lines[uriIndex]!;
        if (!uri) continue;
        if (uri.startsWith("#")) continue;

        const resolvedUrl = resolvePlaylistUri(uri, playlistUrl);
        if (resolvedUrl) segments.push(resolvedUrl);
        i = uriIndex;
        break;
      }
    }
  }

  return { initUrl, segments };
}
