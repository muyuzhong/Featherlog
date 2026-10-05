// Icon glyphs referenced by name from manifests. Paths from Lucide (ISC license),
// drawn a little heavier so they read as ink on paper.
const PATHS: Record<string, string> = {
  'scroll-text':
    'M15 12h-5 M15 8h-5 M19 17V5a2 2 0 0 0-2-2H4 M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3',
  'book-open':
    'M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  feather:
    'M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z M16 8 2 22 M17.5 15H9',
  x: 'M18 6 6 18 M6 6l12 12',
  layers:
    'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65 M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
  'user-round': 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M20 21a8 8 0 0 0-16 0',
  'pen-line':
    'M12 20h9 M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z',
};

export function InkIcon({ name, size = 20, strokeWidth = 1.7 }: { name: string; size?: number; strokeWidth?: number }) {
  const d = PATHS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d ? <path d={d} /> : <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}
