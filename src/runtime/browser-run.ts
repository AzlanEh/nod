import { Worker } from 'node:worker_threads';
import {
  BrowserActionError,
  type BrowserAction,
  type BrowserObservation,
} from '../ports/computer.ts';

const maxSteps = 20;
const scriptTimeoutMs = 30_000;
const maxOutputChars = 40_000;
const maxConsoleLogs = 100;

export interface BrowserRunActResult {
  page: BrowserObservation;
  choice?: string;
}

export interface BrowserRunHandlers {
  signal: AbortSignal;
  act(
    step: BrowserAction,
    started?: () => void,
    options?: { observe?: boolean; signal?: AbortSignal },
  ): Promise<BrowserRunActResult | { output: unknown }>;
  record(
    step: { action: string; text?: string; key?: string },
    page: BrowserObservation,
    choice?: string,
  ): void;
  format(page: BrowserObservation, full?: boolean): string;
  screenshot(signal?: AbortSignal): Promise<Buffer | undefined>;
}

interface ApprovalPause {
  stepIndex: number;
  action: string;
  output: unknown;
}

interface WorkerRequest {
  type: 'call';
  id: number;
  method: string;
  args: unknown[];
}

interface WorkerDone {
  type: 'done';
  result: string;
  hasResult: boolean;
  logs: string[];
}

interface WorkerError {
  type: 'error';
  message: string;
  logs: string[];
}

type WorkerMessage = WorkerRequest | WorkerDone | WorkerError;

const workerSource = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createContext, Script } = require('node:vm');

let nextId = 1;
const pending = new Map();
const logs = [];
const maxLogs = ${maxConsoleLogs};

parentPort.on('message', (msg) => {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.value);
  else entry.reject(new Error(msg.error));
});

function invoke(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', id, method, args });
  });
}

function serialize(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});

const bridge = new Script(\`
(function(invokeJson, logLine) {
  function call(method, args) {
    return invokeJson(method, JSON.stringify(args)).then(function(raw) {
      return raw === undefined ? undefined : JSON.parse(raw);
    });
  }
  function makeArgs() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) out.push(arguments[i]);
    return out;
  }
  const methods = [
    'open', 'snapshot', 'click', 'fill', 'type', 'press', 'select',
    'check', 'uncheck', 'hover', 'drag', 'scroll', 'back', 'forward',
    'reload', 'wait', 'evaluate', 'tabList', 'tabSwitch',
    'acceptDialog', 'dismissDialog', 'screenshot'
  ];
  const page = Object.create(null);
  for (let i = 0; i < methods.length; i++) {
    const name = methods[i];
    page[name] = function() {
      return call(name, makeArgs.apply(null, arguments));
    };
  }
  Object.freeze(page);
  const consoleObj = Object.freeze({
    log: function() { logLine(makeArgs.apply(null, arguments)); },
    warn: function() { logLine(makeArgs.apply(null, arguments)); },
    error: function() { logLine(makeArgs.apply(null, arguments)); },
  });
  globalThis.page = page;
  globalThis.console = consoleObj;
})
\`).runInContext(context);

bridge(
  (method, rawArgs) => {
    let args = [];
    try {
      args = JSON.parse(String(rawArgs));
      if (!Array.isArray(args)) args = [];
    } catch {
      args = [];
    }
    return invoke(String(method), args).then((val) =>
      val === undefined ? undefined : JSON.stringify(val),
    );
  },
  (args) => {
    if (logs.length >= maxLogs) return;
    const parts = [];
    for (let i = 0; i < args.length; i++) parts.push(serialize(args[i]));
    logs.push(parts.join(' ').slice(0, 4000));
  },
);

(async () => {
  try {
    const script = new Script('(async () => {\\n' + workerData.code + '\\n})()', {
      filename: 'browser_run.js',
    });
    const value = await script.runInContext(context);
    const hasResult = value !== undefined;
    const result = hasResult ? serialize(value) : '';
    parentPort.postMessage({ type: 'done', result, hasResult, logs });
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    parentPort.postMessage({ type: 'error', message, logs });
  }
})();
`;

function optObj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Expected string for ${field}.`);
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildAction(
  method: string,
  args: unknown[],
): { step: BrowserAction; observe: boolean } | 'screenshot' {
  if (method === 'screenshot') return 'screenshot';
  switch (method) {
    case 'open': {
      const url = asString(args[0], 'url');
      const opts = optObj(args[1]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'open', url, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'snapshot': {
      const opts = optObj(args[0]);
      const selector = asOptionalString(opts.selector);
      const offset = asOptionalNumber(opts.offset);
      return {
        step: {
          action: 'snapshot',
          ...(selector ? { selector } : {}),
          ...(offset !== undefined ? { offset } : {}),
        },
        observe: true,
      };
    }
    case 'click': {
      const selector = asString(args[0], 'selector');
      const opts = optObj(args[1]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'click', selector, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'fill': {
      const selector = asString(args[0], 'selector');
      const text = asString(args[1], 'text');
      const opts = optObj(args[2]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'fill', selector, text, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'type': {
      const selector = asString(args[0], 'selector');
      const text = asString(args[1], 'text');
      const opts = optObj(args[2]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'type', selector, text, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'press': {
      const key = asString(args[0], 'key');
      const opts = optObj(args[1]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'press', key, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'select': {
      const selector = asString(args[0], 'selector');
      const text = asString(args[1], 'text');
      const opts = optObj(args[2]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'select', selector, text, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'check':
      return { step: { action: 'check', selector: asString(args[0], 'selector') }, observe: false };
    case 'uncheck':
      return {
        step: { action: 'uncheck', selector: asString(args[0], 'selector') },
        observe: false,
      };
    case 'hover':
      return { step: { action: 'hover', selector: asString(args[0], 'selector') }, observe: false };
    case 'drag':
      return {
        step: {
          action: 'drag',
          selector: asString(args[0], 'selector'),
          targetSelector: asString(args[1], 'targetSelector'),
        },
        observe: false,
      };
    case 'scroll': {
      const direction = args[0] === 'up' ? 'up' : 'down';
      const opts = optObj(args[1]);
      const amount = asOptionalNumber(opts.amount);
      const selector = asOptionalString(opts.selector);
      return {
        step: {
          action: 'scroll',
          direction,
          ...(amount !== undefined ? { amount } : {}),
          ...(selector ? { selector } : {}),
        },
        observe: false,
      };
    }
    case 'back':
      return { step: { action: 'back' }, observe: false };
    case 'forward':
      return { step: { action: 'forward' }, observe: false };
    case 'reload':
      return { step: { action: 'reload' }, observe: false };
    case 'wait': {
      const opts = optObj(args[0]);
      const text = asOptionalString(opts.text);
      const url = asOptionalString(opts.url);
      const load =
        opts.load === 'load' || opts.load === 'domcontentloaded' || opts.load === 'networkidle'
          ? opts.load
          : undefined;
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: {
          action: 'wait',
          ...(text ? { text } : {}),
          ...(url ? { url } : {}),
          ...(load ? { load } : {}),
          ...(waitMs !== undefined ? { waitMs } : {}),
        },
        observe: false,
      };
    }
    case 'evaluate':
      return { step: { action: 'evaluate', script: asString(args[0], 'script') }, observe: true };
    case 'tabList':
      return { step: { action: 'tab_list' }, observe: true };
    case 'tabSwitch':
      return {
        step: { action: 'tab_switch', tabId: asString(args[0], 'tabId') },
        observe: false,
      };
    case 'acceptDialog': {
      const text = asOptionalString(args[0]);
      return {
        step: { action: 'accept_dialog', ...(text !== undefined ? { text } : {}) },
        observe: false,
      };
    }
    case 'dismissDialog':
      return { step: { action: 'dismiss_dialog' }, observe: false };
    default:
      throw new Error(`Unknown page method: ${method}`);
  }
}

function formatActionCount(count: number): string {
  return `${count} ${count === 1 ? 'action' : 'actions'}`;
}

export async function runBrowserScript(
  code: string,
  handlers: BrowserRunHandlers,
): Promise<unknown> {
  if (!code.trim()) throw new Error('Provide JavaScript code to run.');
  handlers.signal.throwIfAborted();

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(handlers.signal.reason);
  handlers.signal.addEventListener('abort', onOuterAbort, { once: true });

  const actions: string[] = [];
  let reserved = 0;
  let lastPage: BrowserObservation | undefined;
  let lastObservedText = '';
  let lastWasSnapshot = false;
  let capturedImage: Buffer | undefined;
  let paused: ApprovalPause | undefined;
  let timedOut = false;
  let actionQueue = Promise.resolve();

  const stopError = () => {
    if (paused) return new Error('Browser run paused for approval.');
    if (timedOut) return new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`);
    if (controller.signal.aborted) {
      return controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('Browser run aborted.');
    }
    return undefined;
  };

  const reserveSlot = () => {
    const err = stopError();
    if (err) throw err;
    if (reserved >= maxSteps) throw new Error(`browser_run reached the ${maxSteps}-action limit.`);
    return reserved++;
  };

  const executeMethod = async (method: string, args: unknown[]): Promise<unknown> => {
    const built = buildAction(method, args);
    const index = reserveSlot();
    let result: unknown;
    let failure: unknown;
    const run = async () => {
      const err = stopError();
      if (err) throw err;
      if (built === 'screenshot') {
        const image = await handlers.screenshot(controller.signal);
        actions.push('screenshot');
        capturedImage = image;
        return Boolean(image);
      }
      const { step, observe } = built;
      let started = false;
      let done: BrowserRunActResult | { output: unknown };
      try {
        done = await handlers.act(
          step,
          () => {
            started = true;
          },
          { observe, signal: controller.signal },
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const ran = actions.length
          ? `Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}. `
          : '';
        const status = started ? 'failed and may have taken effect' : 'did not run';
        const detail = `${ran}Action ${index + 1} (${step.action}) ${status}. ${message}`;
        if (error instanceof BrowserActionError) {
          throw new Error(detail, { cause: error });
        }
        throw new Error(detail, { cause: error });
      }
      if ('output' in done) {
        paused = { stepIndex: index, action: step.action, output: done.output };
        controller.abort(new Error('Browser run paused for approval.'));
        throw new Error('Browser run paused for approval.');
      }
      actions.push(step.action);
      handlers.record(step, done.page, done.choice);
      lastPage = done.page;
      lastWasSnapshot = step.action === 'snapshot';
      if (done.page.text) lastObservedText = done.page.text;

      if (step.action === 'evaluate') {
        const prefix = 'Script result (JSON):\n';
        if (done.page.text.startsWith(prefix)) {
          try {
            return JSON.parse(done.page.text.slice(prefix.length));
          } catch {
            return done.page.text.slice(prefix.length);
          }
        }
        return done.page.text;
      }
      if (step.action === 'tab_list') return done.page.text;
      if (step.action === 'wait') {
        return { url: done.page.url, text: done.page.text, unmet: done.page.unmet ?? false };
      }
      return { url: done.page.url, text: done.page.text };
    };

    const queued = actionQueue.then(
      () => run(),
      () => run(),
    );
    actionQueue = queued.then(
      (value) => {
        result = value;
      },
      (error) => {
        failure = error;
      },
    );
    await actionQueue;
    if (failure !== undefined) throw failure;
    return result;
  };

  let logs: string[] = [];
  let serialized = '';
  let hasResult = false;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const terminateWorker = async () => {
    const current = worker;
    worker = undefined;
    if (!current) return;
    await current.terminate().catch(() => {});
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = () => {
        void terminateWorker();
        finish(() => {
          if (paused) resolve();
          else if (timedOut)
            reject(new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`));
          else
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error('Browser run aborted.'),
            );
        });
      };

      controller.signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`));
      }, scriptTimeoutMs);

      worker = new Worker(workerSource, {
        eval: true,
        workerData: { code },
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });

      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'call') {
          void executeMethod(msg.method, msg.args).then(
            (value) => {
              if (!settled && worker) worker.postMessage({ id: msg.id, ok: true, value });
            },
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              if (!settled && worker) worker.postMessage({ id: msg.id, ok: false, error: message });
            },
          );
          return;
        }
        if (msg.type === 'done') {
          logs = msg.logs;
          serialized = msg.result;
          hasResult = msg.hasResult;
          finish(resolve);
          return;
        }
        if (msg.type === 'error') {
          logs = msg.logs;
          finish(() => reject(new Error(msg.message)));
        }
      });

      worker.on('error', (error) => {
        finish(() => reject(error));
      });

      worker.on('exit', (exitCode) => {
        if (settled) return;
        finish(() => {
          if (paused) resolve();
          else if (timedOut)
            reject(new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`));
          else reject(new Error(`browser_run exited unexpectedly (${exitCode}).`));
        });
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    handlers.signal.removeEventListener('abort', onOuterAbort);
    await terminateWorker();
    await actionQueue.catch(() => {});
  }

  if (paused) {
    const pause: ApprovalPause = paused;
    return {
      steps: actions.length
        ? `Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}.`
        : 'Ran 0 actions.',
      stopped: `Action ${pause.stepIndex + 1} (${pause.action}) and the code after it did not run.`,
      result: pause.output,
    };
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
    } else if (!hasResult) {
      const done = await handlers.act({ action: 'snapshot' }, undefined, {
        observe: true,
        signal: handlers.signal,
      });
      if (!('output' in done)) {
        handlers.record({ action: 'snapshot' }, done.page);
        finalPageText = handlers.format(done.page, false);
      }
    }
  }

  const parts: string[] = [];
  if (actions.length)
    parts.push(`Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}.`);
  if (logs.length) parts.push(`Console:\n${logs.join('\n')}`);
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
