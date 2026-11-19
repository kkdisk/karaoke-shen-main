export function bindMediaSessionHandlers({ onPlay, onPause, onNext, onSeekBy }) {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return;

  const handlers = {
    play: onPlay,
    pause: onPause,
    nexttrack: onNext,
    seekbackward: details => onSeekBy(-(details?.seekOffset || 5)),
    seekforward: details => onSeekBy(details?.seekOffset || 5),
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      // Action not supported by this browser version
    }
  }
}

export function updateMediaSessionMetadata(item, modeLabel) {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (!mediaSession) return;
  if (typeof globalThis.MediaMetadata === 'function') {
    mediaSession.metadata = new globalThis.MediaMetadata({
      title: item.title,
      artist: '卡拉OK神歡唱系統',
      album: modeLabel,
      artwork: item.thumbnail ? [{ src: item.thumbnail, sizes: '320x180', type: 'image/jpeg' }] : [],
    });
  }
}

export function setMediaSessionPlaybackState(state) {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (mediaSession) {
    mediaSession.playbackState = state;
  }
}

export function clearMediaSession() {
  const mediaSession = globalThis.navigator?.mediaSession;
  if (!mediaSession) return;
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
}
