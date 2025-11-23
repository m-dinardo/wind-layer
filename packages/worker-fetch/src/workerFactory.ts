import { getWorkerUrl } from './config';
import InlineWorker from './inlineWorker';

export type MessageListener = (a: { data: any; target: any }) => unknown;

// The main thread interface. Provided by Worker in a browser environment,
export interface WorkerInterface {
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  postMessage(message: any): void;
  terminate(): void;
}

let useInlineWorker = false;

export function setInlineWorkerMode(enabled: boolean) {
  useInlineWorker = enabled;
}

export default function workerFactory() {
  if (useInlineWorker) {
    return new InlineWorker();
  }
  return new Worker(getWorkerUrl());
}
