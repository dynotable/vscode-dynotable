import {describe, expect, it} from 'vitest';
import {LATCHED_REASONS, REASONS} from './reasons';

describe('reasons', () => {
  // The status bar, the toast and the explorer message all read this map. An empty sentence leaves
  // a bare button. The type keeps Reconnect second; the first action must be a fix.
  it.each([...LATCHED_REASONS, 'unbound' as const])('%s has a sentence and a fix', (reason) => {
    const {sentence, actions} = REASONS[reason];
    expect(sentence).not.toBe('');
    expect(actions[0]).not.toBe('reconnect');
  });
});
