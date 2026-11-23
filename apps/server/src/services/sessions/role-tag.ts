/**
 * A title starting with a bracketed role tag such as `[Browser Operator]` opts a session into
 * extra capabilities. Titles CodeDen derives from outside text, including generated titles,
 * issue titles and template variables, must strip leading tags. Only a title explicitly set by
 * the user or a PM may carry a role tag.
 */
export const BROWSER_OPERATOR_TAG = "[Browser Operator]";

/** Checks for a leading role tag written literally in an automation title template. */
export function startsWithLiteralTag(text: string): boolean {
  const tag = /^\s*\[[^\]]*\]/.exec(text)?.[0];
  return tag !== undefined && !tag.includes("{{");
}

/** Removes all leading bracketed tags and their surrounding whitespace. */
export function stripLeadingTags(text: string): string {
  return text.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "");
}
