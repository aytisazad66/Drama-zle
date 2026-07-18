---
name: Drama Downloader
description: Architecture decisions and gotchas for the dramadizilerim.com scraper + Expo downloader app
---

## Token extraction regex
Use a **global scan** `/embed\.php\?ct=([^"'&\s<>\n\r]+)/g` on the raw HTML — this reliably finds all 48 episode ct-tokens (1 iframe + 47 lazy-player divs). A scoped `data-src="..."` regex was unreliable. Deduplicate with a `Set`.

**Why:** The site has 1 active iframe + 47 `class="lazy-player"` divs all present in the raw (non-JS) HTML; all ct tokens are server-rendered.

## expo-file-system import path
Import as `expo-file-system/legacy` (not `expo-file-system`) in SDK 54+. The main export is the new file-classes API; `documentDirectory`, `createDownloadResumable`, `DownloadResumable` live under the legacy subpath.

**Why:** expo-file-system v19 restructured exports; the legacy API (download resumable, documentDirectory, etc.) moved to the `/legacy` subpath.

## Metro + pnpm symlinks
Add to `metro.config.js`:
```js
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [localNodeModules, workspaceNodeModules];
config.watchFolders = [workspaceRoot];
```
Without this, packages installed in `drama-downloader/node_modules` may not resolve because Metro doesn't follow pnpm symlinks by default.

## Title cleanup regex
```ts
title
  .replace(/\s*\|.*$/, '')
  .replace(/\s+(Sezon|Season)\s+\d+.*/i, '')
  .replace(/\s+Bölüm\s+\d+.*/i, '')
  .trim()
```
The `<title>` tag returns "Series Name Sezon 1 Bölüm 1 | DramaDizilerim" — strip everything after `|` and the season/episode suffix.

## Native tab imports crash web
`NativeTabs`, `Icon`, `Label` from `expo-router/unstable-native-tabs` and `SymbolView` from `expo-symbols` crash during module load on web even if not rendered. Use a simple `<Tabs>` with `@expo/vector-icons` for cross-platform tab layout.

## Stream-video endpoint
`GET /api/drama/stream-video?m3u8Url=URL&quality=1` downloads the fMP4 init segment + all numbered segments sequentially from `dizi.dramadizilerim.com`, piping them to the response. quality=0 is 1080p, quality=1 is next-best. Uses chunked transfer encoding; client gets `X-Segment-Count` header.

## Cloudflare / server-side fetch
Plain Node.js fetch (no cookies) successfully fetches the drama page HTML — Cloudflare does not block it in this context. The site serves fully server-rendered HTML including all episode ct-tokens without requiring JS execution.
