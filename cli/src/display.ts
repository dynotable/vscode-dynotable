const NAMED: Record<string, string> = {'\n': '⏎', '\t': '⇥', '\r': '␍'};

/**
 * `text` with every C0 and C1 control character and DEL made visible, so data and app text cannot
 * write escape sequences to the terminal or break a table's columns.
 */
export function visible(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    return NAMED[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}
