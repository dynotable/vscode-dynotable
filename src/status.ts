import * as vscode from 'vscode';
import type {State} from './connect-core';
import {ACTION_LABELS, REASONS, type Action, type LatchedReason} from './reasons';

export type StatusModel =
  | {kind: 'hidden'}
  | {kind: 'starting'; waitingForRun: boolean}
  /** `requested` is the profile asked for at `initialize`. The server does not confirm it. */
  | {kind: 'connected'; requested?: string}
  | {kind: 'unbound'}
  | {kind: 'disconnected'; reason: LatchedReason};

export function statusOf(state: State, unbound: boolean, requested?: string): StatusModel {
  switch (state.kind) {
    case 'idle':
      return {kind: 'hidden'};
    case 'starting':
    case 'waiting-for-run':
      return {kind: 'starting', waitingForRun: state.kind === 'waiting-for-run'};
    case 'connected':
      return unbound ? {kind: 'unbound'} : {kind: 'connected', requested};
    case 'latched':
      return {kind: 'disconnected', reason: state.reason};
  }
}

/** Reconnect is always one click away: a fix such as a licence activation writes no new port file. */
function actionsOf(model: StatusModel): Action[] {
  switch (model.kind) {
    case 'unbound':
      return REASONS.unbound.actions;
    case 'disconnected':
      return REASONS[model.reason].actions;
    default:
      return ['reconnect'];
  }
}

export const STATUS_COMMAND = 'dynotable.statusActions';

export function paint(item: vscode.StatusBarItem, model: StatusModel): void {
  if (model.kind === 'hidden') {
    item.hide();
    return;
  }
  item.command = STATUS_COMMAND;
  switch (model.kind) {
    case 'starting':
      item.text = '$(sync~spin) DynoTable';
      item.tooltip = model.waitingForRun
        ? 'DynoTable reconnects when the current run ends.'
        : 'Connecting to DynoTable…';
      break;
    case 'connected':
      item.text = model.requested
        ? `$(database) DynoTable: ${model.requested}`
        : '$(database) DynoTable';
      item.tooltip = model.requested
        ? `Connected to DynoTable. Requested profile: ${model.requested}.`
        : 'Connected to DynoTable.';
      break;
    case 'unbound':
      item.text = '$(warning) DynoTable';
      item.tooltip = REASONS.unbound.sentence;
      break;
    case 'disconnected':
      item.text = '$(debug-disconnect) DynoTable';
      item.tooltip = REASONS[model.reason].sentence;
      break;
  }
  item.show();
}

/** Shows the reason's sentence with its actions, and returns the action the user picked. */
export async function notify(reason: LatchedReason): Promise<Action | undefined> {
  const {sentence, actions} = REASONS[reason];
  const picked = await vscode.window.showErrorMessage(
    sentence,
    ...actions.map((action) => ACTION_LABELS[action])
  );
  return actions.find((action) => ACTION_LABELS[action] === picked);
}

export async function pickAction(model: StatusModel): Promise<Action | undefined> {
  const actions = actionsOf(model);
  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({label: ACTION_LABELS[action], action})),
    {placeHolder: model.kind === 'disconnected' ? REASONS[model.reason].sentence : undefined}
  );
  return picked?.action;
}
