import {randomUUID} from 'node:crypto';
import * as vscode from 'vscode';
import {is, runResultSchema, type RunResult} from './protocol';
import {
  parseMessage,
  renderHtml,
  resultView,
  toCsv,
  toJson,
  type RenderMessage,
  type View
} from './results-model';

const COPIED_MESSAGE_MS = 3000;

export type RunOutcome =
  | {kind: 'ok'}
  | {kind: 'unreadable'}
  | {kind: 'failed'; error: unknown; cancelled: boolean};

/** The one reusable results panel. It holds one run at a time. */
export class ResultsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private view: View = {kind: 'empty'};
  private result: RunResult | undefined;
  private run: {id: string; source: vscode.CancellationTokenSource} | undefined;
  /** The last run's outcome, for the Test-mode hook. */
  last: RunOutcome | undefined;

  /** `script` returns the webview script's text. */
  constructor(private readonly script: () => string) {}

  get current(): View {
    return this.view;
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
      this.result = answer;
      this.show(resultView(answer));
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
      case 'copy': {
        if (!this.result) return;
        const text = message.format === 'csv' ? toCsv(this.result) : toJson(this.result);
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(
          `Copied ${this.result.returnedRows} rows as ${message.format.toUpperCase()}.`,
          COPIED_MESSAGE_MS
        );
      }
    }
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
