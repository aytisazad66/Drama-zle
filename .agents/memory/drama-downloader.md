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

## SAF folder copy for Android external storage
After download to `documentDirectory`, use `FileSystem.StorageAccessFramework` to copy to a user-chosen public folder (e.g. `indirilendramalar`). Flow: user taps folder banner → `requestDirectoryPermissionsAsync()` → URI stored in AsyncStorage → after each download, `createFileAsync` + `readAsStringAsync(base64)` + `writeAsStringAsync(base64)`.

**Why:** Android 13+ forbids direct writes to external storage without SAF. `expo-media-library` (MediaStore) is the proper solution but requires a rebuild. SAF via `expo-file-system` works without a rebuild. Caveat: base64 copy may OOM for very large files (>~300MB); failure is caught and treated as non-fatal (file stays in documentDirectory).

Folder URI is stored under AsyncStorage key `save_folder_uri` and mirrored in `saveFolderRef` (a `useRef`) inside `DownloadContext` so it's accessible synchronously inside the download callback without stale closure issues.

## Stream-video endpoint
`GET /api/drama/stream-video?m3u8Url=URL&quality=1` downloads the fMP4 init segment + all numbered segments sequentially from `dizi.dramadizilerim.com`, piping them to the response. quality=0 is 1080p, quality=1 is next-best. Uses chunked transfer encoding; client gets `X-Segment-Count` header.

## Cloudflare / server-side fetch
Plain Node.js fetch (no cookies) successfully fetches the drama page HTML — Cloudflare does not block it in this context. The site serves fully server-rendered HTML including all episode ct-tokens without requiring JS execution.

## Cloudflare Stream token scope
The Cloudflare Stream URL-copy upload endpoint requires the API token permission `Stream Write`.

**Why:** Cloudflare rejects the upload request with HTTP 401 when the configured token is not accepted; the official endpoint documents `Stream Write` as an accepted permission.

**How to apply:** When setting `CF_STREAM_TOKEN`, use a token scoped to the same account as `CF_ACCOUNT_ID` and grant `Stream Write`.

## User-owned source and destination

The user stated that they own both the drama site and the Cloudflare account used by this project.

**Why:** The user explicitly confirmed ownership after being asked.

**How to apply:** Do not ask the user to prove ownership again; keep ownership separate from any other constraints on implementation.
