export const MAX_PLAYLIST_SIZE = 500;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const STORAGE_KEY = 'shen-playlist-v2';
export const QUALITY_STORAGE_KEY = 'shen-quality-v1';
export const ALLOWED_QUALITIES = [720, 1080, 1440];
export const DEFAULT_QUALITY = 1080;

export function normalizeQuality(value, fallback = DEFAULT_QUALITY) {
  const num = Number(value);
  return ALLOWED_QUALITIES.includes(num) ? num : fallback;
}

export function safeThumbnail(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'i.ytimg.com' || url.hostname.endsWith('.ytimg.com'))
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function validItem(item) {
  return Boolean(
    item &&
      typeof item.id === 'string' &&
      /^[A-Za-z0-9_-]{11}$/.test(item.id) &&
      typeof item.title === 'string' &&
      item.title.length <= 500
  );
}

export const MAX_DURATION_SECONDS = 24 * 60 * 60;

/** Whole seconds in (0, 24h], or null. Older saved/imported playlists have no duration. */
export function safeDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const seconds = Math.round(value);
  return seconds > 0 && seconds <= MAX_DURATION_SECONDS ? seconds : null;
}

/** 211 → "3:31", 3725 → "1:02:05". */
export function formatDuration(seconds) {
  const total = safeDuration(seconds);
  if (total === null) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function sanitize(item) {
  return {
    id: item.id,
    title: item.title,
    thumbnail: safeThumbnail(item.thumbnail),
    url: `https://www.youtube.com/watch?v=${item.id}`,
    duration: safeDuration(item.duration),
  };
}
