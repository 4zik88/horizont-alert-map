/** A message as extracted from a t.me/s/ preview page. Pure data, no DB concerns. */
export interface ParsedMessage {
  channel: string;
  messageId: number;
  /** Epoch ms UTC, from the <time datetime> attribute. Authoritative event time. */
  postedAt: number;
  /** Normalised plain text: <br/> -> \n, entities decoded. '' for media-only posts. */
  text: string;
  /** Raw innerHTML of the message body, or null when the post has no text block. */
  textHtml: string | null;
  hasMedia: boolean;
}
