import type { MessageListener, WorkerInterface } from './workerFactory';
import WorkerRuntime from './worker';

/**
 * Inline worker shim that runs the worker runtime on the main thread.
 * This mirrors the postMessage/addEventListener API so existing Actor/Dispatcher
 * code can operate without a real Worker (needed for iOS Safari fallback).
 */
export default class InlineWorker implements WorkerInterface {
  private mainListeners: MessageListener[] = [];
  private workerListeners: MessageListener[] = [];
  private terminated = false;

  constructor() {
    // Create a faux worker global scope that can talk back to the main side.
    const workerScope = {
      addEventListener: (type: 'message', listener: MessageListener) => {
        if (type === 'message') {
          this.workerListeners.push(listener);
        }
      },
      removeEventListener: (type: 'message', listener: MessageListener) => {
        if (type === 'message') {
          this.workerListeners = this.workerListeners.filter((l) => l !== listener);
        }
      },
      postMessage: (message: any) => {
        // Worker -> main
        this.emitToMain({ data: message, target: this });
      },
      importScripts: (..._urls: string[]) => {
        // In inline mode we assume worker deps are already bundled; no-op.
      },
    };

    // Spin up the worker runtime on the faux scope.
    // eslint-disable-next-line no-new
    new WorkerRuntime(workerScope as any);
  }

  addEventListener(type: 'message', listener: MessageListener): void {
    if (type === 'message') {
      this.mainListeners.push(listener);
    }
  }

  removeEventListener(type: 'message', listener: MessageListener): void {
    if (type === 'message') {
      this.mainListeners = this.mainListeners.filter((l) => l !== listener);
    }
  }

  postMessage(message: any): void {
    if (this.terminated) return;
    // Main -> worker
    this.emitToWorker({ data: message, target: this });
  }

  terminate(): void {
    this.terminated = true;
    this.mainListeners = [];
    this.workerListeners = [];
  }

  private emitToMain(event: { data: any; target: any }) {
    this.mainListeners.forEach((listener) => listener(event));
  }

  private emitToWorker(event: { data: any; target: any }) {
    this.workerListeners.forEach((listener) => listener(event));
  }
}
