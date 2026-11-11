import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {posix} from 'node:path';
import * as vscode from 'vscode';
import {is, runResultSchema, type RunResult} from './protocol';
import {
  copyText,
  formatText,
  parseMessage,
  renderHtml,
  resultView,
  savedStatus,
  type CopyFormat,
  type RenderMessage,
  type View
} from './results-model';

const COPIED_MESSAGE_MS = 3000;

const EXPORT_FORMATS: Array<vscode.QuickPickItem & {format: CopyFormat; extension: string}> = [
  {label: 'CSV', format: 'csv', extension: 'csv'},
  {label: 'JSON', format: 'json', extension: 'json'},
  {label: 'Markdown', format: 'markdown', extension: 'md'}
];

export type RunOutcome =
  | {kind: 'ok'}
  | {kind: 'unreadable'}
  | {kind: 'failed'; error: unknown; cancelled: boolean};

/** The one reusable results panel. It holds one run at a time. */
export class ResultsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private view: View = {kind: 'empty'};
  /** Set on success only, so a failed run that restores the old view keeps the old id current. */
  private result: {value: RunResult; id: string} | undefined;
  private run: {id: string; source: vscode.CancellationTokenSource} | undefined;
  /** The last run's outcome, for the Test-mode hook. */
  last: RunOutcome | undefined;

  /** `script` returns the webview script's text. */
  constructor(private readonly script: () => string) {}

  get current(): View {
    return this.view;
  }

  get runResult(): RunResult | undefined {
    return this.result?.value;
  }

  /**
   * Runs `send` with the panel open on the running state. Returns `undefined`, and sends nothing,
   * while another run holds the panel.
   */
  async execute(
    send: (token: vscode.CancellationToken) => Thenable<unknown>
  ): Promise<RunOutcome | undefined> {
    if (this.run) return undefined;
    const run = {id: randomUUID(), source: new vscode.CancellationTokenSource()};
    this.run = run;
    const before = this.view;
    this.open();
    this.show({kind: 'running', runId: run.id});
    try {
      const answer = await send(run.source.token);
      // A reply already in flight can still arrive after the user's Cancel.
      if (run.source.token.isCancellationRequested) {
        this.show({kind: 'cancelled'});
        return (this.last = {
          kind: 'failed',
          error: new vscode.CancellationError(),
          cancelled: true
        });
      }
      if (!is(runResultSchema, answer)) {
        this.show(before);
        return (this.last = {kind: 'unreadable'});
      }
      this.result = {value: answer, id: run.id};
      this.show(resultView(answer, run.id));
      return (this.last = {kind: 'ok'});
    } catch (error) {
      const cancelled = run.source.token.isCancellationRequested;
      this.show(cancelled ? {kind: 'cancelled'} : before);
      return (this.last = {kind: 'failed', error, cancelled});
    } finally {
      run.source.dispose();
      this.run = undefined;
    }
  }

  /** The webview's messages, validated. A `cancel` acts only on the run it names. */
  async receive(value: unknown): Promise<void> {
    const message = parseMessage(value);
    switch (message?.type) {
      case 'ready':
        this.post();
        return;
      case 'cancel':
        if (message.runId === this.run?.id) this.run.source.cancel();
        return;
      case 'copy':
      case 'copySelection':
      case 'copyValue':
      case 'copyColumn':
      case 'copyColumnName': {
        const copy = this.result && copyText(this.result.value, this.result.id, message);
        if (copy) {
          await vscode.env.clipboard.writeText(copy.text);
          vscode.window.setStatusBarMessage(copy.status, COPIED_MESSAGE_MS);
        } else if (message.resultId !== this.result?.id) {
          vscode.window.setStatusBarMessage('The results changed. Copy again.', COPIED_MESSAGE_MS);
        }
        return;
      }
      case 'export':
        await this.export(message.resultId);
    }
  }

  /** Saves the rows in query order. A run that ends during the dialogs does not change them. */
  private async export(resultId: string): Promise<void> {
    const result = this.result;
    if (result?.id !== resultId) {
      vscode.window.setStatusBarMessage('The results changed. Export again.', COPIED_MESSAGE_MS);
      return;
    }
    const picked = await vscode.window.showQuickPick(EXPORT_FORMATS, {
      placeHolder: 'Select the export format'
    });
    if (!picked) return;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, `dynotable-results.${picked.extension}`)
    });
    if (!uri) return;
    const {rows, columns} = result.value;
    const text = formatText(
      result.value,
      [...rows.keys()],
      [...columns.keys()],
      picked.format,
      true
    );
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`The rows were not saved: ${reason}`);
      return;
    }
    vscode.window.setStatusBarMessage(
      savedStatus(rows.length, posix.basename(uri.path)),
      COPIED_MESSAGE_MS
    );
  }

  /** Closing the panel cancels the run. */
  close(): void {
    this.panel?.dispose();
  }

  dispose(): void {
    this.run?.source.cancel();
    this.close();
  }

  private open(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dynotable.results',
      'DynoTable Results',
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
      {enableScripts: true, localResourceRoots: []}
    );
    panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.run?.source.cancel();
    });
    panel.webview.html = renderHtml(this.script());
    this.panel = panel;
  }

  /** A closed panel stays closed: a run that ends after the close does not reopen it. */
  private show(view: View): void {
    this.view = view;
    this.post();
  }

  private post(): void {
    const message: RenderMessage = {type: 'render', view: this.view};
    void this.panel?.webview.postMessage(message);
  }
}
