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

export function sanitize(item) {
  return {
    id: item.id,
    title: item.title,
    thumbnail: safeThumbnail(item.thumbnail),
    url: `https://www.youtube.com/watch?v=${item.id}`,
  };
}
