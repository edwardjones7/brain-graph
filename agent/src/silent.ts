const OWN_LINE = /^[\s*`_]*NOTHING_TO_SEND[\s*`_.]*$/m;
const AT_END = /NOTHING_TO_SEND[\s*`_.]*$/;

/**
 * Whether a run chose to say nothing. Scheduled jobs end with NOTHING_TO_SEND when there's nothing
 * worth a notification, which is what keeps a proactive agent from becoming noise. Models often
 * explain themselves before the marker, so it counts on its own line or at the very end; a mention
 * mid-sentence still sends.
 */
export function isSilent(text: string): boolean {
  return !text.trim() || OWN_LINE.test(text) || AT_END.test(text);
}
