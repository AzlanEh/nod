import { createContext, Script } from 'node:vm';
import {
  BrowserActionError,
  type BrowserAction,
  type BrowserObservation,
} from '../ports/computer.ts';

const maxSteps = 20;
const scriptTimeoutMs = 30_000;
const maxOutputChars = 40_000;

export interface BrowserRunActResult {
  page: BrowserObservation;
  choice?: string;
}

export interface BrowserRunHandlers {
  signal: AbortSignal;
  act(
    step: BrowserAction,
    started?: () => void,
  ): Promise<BrowserRunActResult | { output: unknown }>;
  record(
    step: { action: string; text?: string; key?: string },
    page: BrowserObservation,
    choice?: string,
  ): void;
  format(page: BrowserObservation, full?: boolean): string;
  screenshot(): Promise<Buffer | undefined>;
}

class ApprovalPause extends Error {
  constructor(
    readonly stepIndex: number,
    readonly action: string,
    readonly output: unknown,
  ) {
    super('Browser run paused for approval.');
  }
}

class StepLimitError extends Error {
  constructor() {
    super(`browser_run reached the ${maxSteps}-action limit.`);
  }
}

function serializeResult(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export async function runBrowserScript(
  code: string,
  handlers: BrowserRunHandlers,
): Promise<unknown> {
  if (!code.trim()) throw new Error('Provide JavaScript code to run.');

  const actions: string[] = [];
  let lastPage: BrowserObservation | undefined;
  let lastObservedText = '';
  let lastWasSnapshot = false;
  let capturedImage: Buffer | undefined;
  let paused: ApprovalPause | undefined;

  const checkLimit = () => {
    handlers.signal.throwIfAborted();
    if (actions.length >= maxSteps) throw new StepLimitError();
  };

  const runAction = async (
    step: BrowserAction,
    options?: { observe?: boolean },
  ): Promise<BrowserObservation> => {
    checkLimit();
    const index = actions.length;
    const withObserve: BrowserAction =
      options?.observe === false &&
      step.action !== 'snapshot' &&
      step.action !== 'evaluate' &&
      step.action !== 'tab_list'
        ? { ...step, observe: false }
        : step;
    let started = false;
    let done: BrowserRunActResult | { output: unknown };
    try {
      done = await handlers.act(withObserve, () => {
        started = true;
      });
    } catch (error) {
      if (handlers.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const ran = actions.length ? `Ran ${actions.length} actions: ${actions.join(', ')}. ` : '';
      const status = started ? 'failed and may have taken effect' : 'did not run';
      const detail = `${ran}Action ${index + 1} (${step.action}) ${status}. ${message}`;
      if (error instanceof BrowserActionError) {
        const wrapped = new Error(detail, { cause: error });
        throw wrapped;
      }
      throw new Error(detail, { cause: error });
    }
    if ('output' in done) {
      paused = new ApprovalPause(index, step.action, done.output);
      throw paused;
    }
    actions.push(step.action);
    handlers.record(step, done.page, done.choice);
    lastPage = done.page;
    lastWasSnapshot = step.action === 'snapshot';
    if (done.page.text) lastObservedText = done.page.text;
    return done.page;
  };

  const page = Object.freeze({
    async open(url: string, opts?: { waitMs?: number }) {
      const obs = await runAction(
        { action: 'open', url, ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}) },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async snapshot(opts?: { selector?: string; offset?: number }) {
      const obs = await runAction({
        action: 'snapshot',
        ...(opts?.selector ? { selector: opts.selector } : {}),
        ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
      });
      return { url: obs.url, text: obs.text };
    },
    async click(selector: string, opts?: { waitMs?: number }) {
      const obs = await runAction(
        {
          action: 'click',
          selector,
          ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
        },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async fill(selector: string, text: string, opts?: { waitMs?: number }) {
      const obs = await runAction(
        {
          action: 'fill',
          selector,
          text,
          ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
        },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async type(selector: string, text: string, opts?: { waitMs?: number }) {
      const obs = await runAction(
        {
          action: 'type',
          selector,
          text,
          ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
        },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async press(key: string, opts?: { waitMs?: number }) {
      const obs = await runAction(
        { action: 'press', key, ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}) },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async select(selector: string, text: string, opts?: { waitMs?: number }) {
      const obs = await runAction(
        {
          action: 'select',
          selector,
          text,
          ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
        },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async check(selector: string) {
      const obs = await runAction({ action: 'check', selector }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async uncheck(selector: string) {
      const obs = await runAction({ action: 'uncheck', selector }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async hover(selector: string) {
      const obs = await runAction({ action: 'hover', selector }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async drag(selector: string, targetSelector: string) {
      const obs = await runAction({ action: 'drag', selector, targetSelector }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async scroll(direction: 'up' | 'down' = 'down', opts?: { amount?: number; selector?: string }) {
      const obs = await runAction(
        {
          action: 'scroll',
          direction,
          ...(opts?.amount !== undefined ? { amount: opts.amount } : {}),
          ...(opts?.selector ? { selector: opts.selector } : {}),
        },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async back() {
      const obs = await runAction({ action: 'back' }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async forward() {
      const obs = await runAction({ action: 'forward' }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async reload() {
      const obs = await runAction({ action: 'reload' }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async wait(opts: {
      text?: string;
      url?: string;
      load?: 'load' | 'domcontentloaded' | 'networkidle';
      waitMs?: number;
    }) {
      const obs = await runAction(
        {
          action: 'wait',
          ...(opts.text ? { text: opts.text } : {}),
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.load ? { load: opts.load } : {}),
          ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
        },
        { observe: false },
      );
      return { url: obs.url, text: obs.text, unmet: obs.unmet ?? false };
    },
    async evaluate(script: string) {
      const obs = await runAction({ action: 'evaluate', script });
      const prefix = 'Script result (JSON):\n';
      if (obs.text.startsWith(prefix)) {
        try {
          return JSON.parse(obs.text.slice(prefix.length));
        } catch {
          return obs.text.slice(prefix.length);
        }
      }
      return obs.text;
    },
    async tabList() {
      const obs = await runAction({ action: 'tab_list' });
      return obs.text;
    },
    async tabSwitch(tabId: string) {
      const obs = await runAction({ action: 'tab_switch', tabId }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async acceptDialog(text?: string) {
      const obs = await runAction(
        { action: 'accept_dialog', ...(text !== undefined ? { text } : {}) },
        { observe: false },
      );
      return { url: obs.url, text: obs.text };
    },
    async dismissDialog() {
      const obs = await runAction({ action: 'dismiss_dialog' }, { observe: false });
      return { url: obs.url, text: obs.text };
    },
    async screenshot() {
      checkLimit();
      actions.push('screenshot');
      capturedImage = await handlers.screenshot();
      return Boolean(capturedImage);
    },
  });

  const logs: string[] = [];
  const consoleProxy = Object.freeze({
    log: (...args: unknown[]) => logs.push(args.map(serializeResult).join(' ')),
    warn: (...args: unknown[]) => logs.push(args.map(serializeResult).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map(serializeResult).join(' ')),
  });

  const sandbox = createContext(
    {
      page,
      console: consoleProxy,
      JSON,
      Math,
      Date,
      RegExp,
      URL,
      URLSearchParams,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      Promise,
      Error,
      TypeError,
      RangeError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );

  const wrapped = `(async () => {\n${code}\n})()`;
  let script: Script;
  try {
    script = new Script(wrapped, { filename: 'browser_run.js' });
  } catch (error) {
    throw new Error(
      `Invalid browser_run JavaScript: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let returnValue: unknown;
  try {
    const promise = script.runInContext(sandbox, { timeout: scriptTimeoutMs }) as Promise<unknown>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`));
      }, scriptTimeoutMs);
    });
    const onAbort = () => {
      if (timer) clearTimeout(timer);
    };
    handlers.signal.addEventListener('abort', onAbort, { once: true });
    try {
      returnValue = await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      handlers.signal.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    if (error instanceof ApprovalPause) {
      return {
        steps: actions.length
          ? `Ran ${actions.length} actions: ${actions.join(', ')}.`
          : 'Ran 0 actions.',
        stopped: `Action ${error.stepIndex + 1} (${error.action}) and the code after it did not run.`,
        result: error.output,
      };
    }
    if (paused) {
      return {
        steps: actions.length
          ? `Ran ${actions.length} actions: ${actions.join(', ')}.`
          : 'Ran 0 actions.',
        stopped: `Action ${paused.stepIndex + 1} (${paused.action}) and the code after it did not run.`,
        result: paused.output,
      };
    }
    throw error;
  }

  handlers.signal.throwIfAborted();

  let finalPageText = '';
  if (actions.length > 0 && !capturedImage) {
    if (lastPage && lastObservedText && lastWasSnapshot) {
      finalPageText = handlers.format(lastPage, true);
    } else if (
      lastPage &&
      lastPage.text.startsWith('A ') &&
      lastPage.text.includes('dialog blocks the page')
    ) {
      finalPageText = `URL: ${lastPage.url}\n${lastPage.text}`;
    } else if (returnValue === undefined) {
      const done = await handlers.act({ action: 'snapshot' });
      if (!('output' in done)) {
        handlers.record({ action: 'snapshot' }, done.page);
        finalPageText = handlers.format(done.page, false);
      }
    }
  }

  const parts: string[] = [];
  if (actions.length) parts.push(`Ran ${actions.length} actions: ${actions.join(', ')}.`);
  if (logs.length) parts.push(`Console:\n${logs.join('\n')}`);
  const serialized = serializeResult(returnValue);
  if (serialized) parts.push(`Result:\n${serialized}`);
  if (finalPageText) parts.push(finalPageText);

  let text = parts.join('\n\n') || 'Done.';
  if (text.length > maxOutputChars) {
    text = `${text.slice(0, maxOutputChars)}\n… (truncated)`;
  }

  if (capturedImage) {
    return {
      content: [
        { type: 'text', text },
        { type: 'image', data: capturedImage.toString('base64'), mimeType: 'image/png' },
      ],
      details: {},
    };
  }

  return text;
}
