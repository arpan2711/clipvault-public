// Readable titles for videos. Files keep their full names on disk ("League of Legends 2026-10-17
// 22-55-13 Double kill"), but the app shows what the video is ("Double kill"). A file the user
// renamed keeps its own name.

const DEFAULT_NAME = /^(.+?) \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: \(\d+\))?(?: (.+))?$/;
const TRIM = / \(trim(?: \d+)?\)$/;

// -> { title, trimmed, renamed }
export function describeName(item) {
  const name = String(item.name || '');
  const trimmed = TRIM.test(name);
  const base = name.replace(TRIM, '');
  const m = DEFAULT_NAME.exec(base);
  if (!m) return { title: base || 'Video', trimmed, renamed: true };
  const suffix = m[2] || '';
  let title;
  if (item.type === 'highlight') title = item.label || suffix || 'Highlight';
  else if (item.type === 'recording') title = item.stats || /\bMatch$/.test(suffix) ? 'Full match' : 'Recording';
  else if (item.type === 'map') title = 'Match minimap';
  else if (item.type === 'montage') title = 'Highlight video';
  else if (item.label === 'Bookmark' || item.event === 'bookmark') title = 'Bookmark';
  else title = item.label || 'Instant replay';
  return { title, trimmed, renamed: false };
}

export const displayTitle = (item) => describeName(item).title;
