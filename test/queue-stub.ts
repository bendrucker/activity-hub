export interface QueueStub<T = unknown> extends Queue<T> {
  messages: T[];
}

export function stubQueue<T = unknown>(): QueueStub<T> {
  const messages: T[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(batch) {
      for (const item of batch) {
        messages.push(item.body);
      }
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
}
