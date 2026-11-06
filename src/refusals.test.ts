import {describe, expect, it} from 'vitest';
import {
  CONNECTION_INACTIVE,
  OPEN_IN_APP,
  PENDING_RESPONSE_REJECTED,
  refusalOf,
  RUN_STATEMENT
} from './refusals';

const refused = (code: string) => ({code: -32803, message: 'No.', data: {code}});

describe('refusalOf', () => {
  // The lenient guard lets a newer server's code through; it must not get another code's action.
  // `constructor` is an Object.prototype key: a plain lookup returns a function, not an action list.
  it.each(['quota-spent', 'constructor'])(
    'keeps the sentence of unknown code %s and offers no action',
    (code) => {
      const failure = {code: -32803, message: 'Quota spent.', data: {code}};
      expect(refusalOf(failure, false, RUN_STATEMENT)).toEqual({
        kind: 'message',
        message: 'Quota spent.',
        actions: []
      });
    }
  );

  it('keeps the sentence of a -32803 with no data', () => {
    expect(refusalOf({code: -32803, message: 'No.'}, false, RUN_STATEMENT)).toEqual({
      kind: 'message',
      message: 'No.',
      actions: []
    });
  });

  it.each([
    ['profile-required', 'select-profile'],
    ['signed-out', 'open-app'],
    ['profile-window-required', 'open-app'],
    ['reauth-required', 'open-app']
  ])('%s offers %s', (code, action) => {
    expect(refusalOf(refused(code), false, OPEN_IN_APP)).toEqual({
      kind: 'message',
      message: 'No.',
      actions: [action]
    });
  });

  // Stage sends openInApp. If its refusal offered Stage too, each click would toast again.
  it.each([
    [RUN_STATEMENT, ['stage']],
    [OPEN_IN_APP, []]
  ])('stage-in-app from %s offers %j', (command, actions) => {
    expect(refusalOf(refused('stage-in-app'), false, command)).toEqual({
      kind: 'message',
      message: 'No.',
      actions
    });
  });

  // The user asked for the cancel; the server's refusal of the run is not news.
  it('is silent for a run this client cancelled', () => {
    expect(refusalOf(refused('run-failed'), true, RUN_STATEMENT)).toEqual({kind: 'silent'});
  });

  // The session's end is announced once, by its latched reason.
  it('is silent for a request that the closed connection dropped', () => {
    expect(
      refusalOf({code: PENDING_RESPONSE_REJECTED, message: 'closed'}, false, RUN_STATEMENT)
    ).toEqual({kind: 'silent'});
  });

  // The library's "Client is not running" says nothing the user can act on.
  it('shows the connection status for a request on a stopped client', () => {
    expect(
      refusalOf({code: CONNECTION_INACTIVE, message: 'Client is not running'}, false, RUN_STATEMENT)
    ).toEqual({kind: 'status'});
  });
});
