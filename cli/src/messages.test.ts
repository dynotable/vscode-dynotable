import {describe, expect, it} from 'vitest';
import {FAILURE_CODES, REQUEST_FAILED} from '../../src/protocol';
import {LATCHED_REASONS} from '../../src/reasons';
import {CLI_CODES, codeOfError, messageOf} from './messages';

const CODES = [...new Set([...LATCHED_REASONS, ...FAILURE_CODES, ...CLI_CODES])];

describe('messageOf', () => {
  // A copied line would tell an agent the wrong fix.
  it('gives every code its own message', () => {
    const messages = CODES.map(messageOf);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(CODES.length);
  });

  // The CLI has no settings; its configuration is flags and environment variables.
  it('names no editor setting', () => {
    for (const code of CODES) {
      expect(messageOf(code)).not.toMatch(/dynotable\.appPath|dynotable\.userDataDir|\bsetting\b/i);
    }
  });
});

describe('codeOfError', () => {
  it('passes a known code through', () => {
    const error = {code: REQUEST_FAILED, message: 'm', data: {code: 'stage-in-app' as const}};
    expect(codeOfError(error)).toBe('stage-in-app');
  });

  // PROTOCOL.md: the list of codes can grow; an unknown code means run-failed.
  it('reads a code this build does not know as run-failed', () => {
    const error = {code: REQUEST_FAILED, message: 'm', data: {code: 'new-code' as never}};
    expect(codeOfError(error)).toBe('run-failed');
  });
});
