/**
 * The hub's iconography, as path data.
 *
 * Kept together so the set can be looked at as a set — they have to read as
 * one family at 22 pixels, which is hard to judge one file at a time.
 */
export const GLYPHS = {
  profile: ['M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8', 'M4 21a8 8 0 0 1 16 0'],
  people: [
    'M9 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7',
    'M2 20a7 7 0 0 1 14 0',
    'M17 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6',
    'M16.5 20a6 6 0 0 1 5.5-6',
  ],
  notifications: ['M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6', 'M10 20a2 2 0 0 0 4 0'],
  appearance: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18', 'M12 3v18a9 9 0 0 0 0-18'],
  backup: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 19h16'],
  storage: ['M12 3l9 4-9 4-9-4z', 'M3 12l9 4 9-4', 'M3 17l9 4 9-4'],
  about: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18', 'M12 11v5', 'M12 8h.01'],
} as const;
