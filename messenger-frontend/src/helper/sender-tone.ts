/**
 * A stable colour slot for a participant's name in a group thread.
 *
 * Derived from the owner id rather than from position in the participant list,
 * because the list reorders as people join and leave — and a name that changes
 * colour is worse than no colour at all. The whole value of colouring names
 * (WhatsApp, Telegram) is that the eye learns the colour instead of reading
 * the text, which only pays off if it never moves.
 *
 * Not a hash with any security meaning: collisions are fine and expected past
 * six participants.
 */
export const SENDER_TONE_COUNT = 6;

export function senderTone(ownerId: string): number {
  let hash = 0;
  for (let index = 0; index < ownerId.length; index += 1) {
    // Mixing every character matters here: platform owner ids share a
    // `google_` prefix, so anything reading only the first few lands
    // everybody on one colour.
    hash = (hash * 31 + ownerId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % SENDER_TONE_COUNT;
}
