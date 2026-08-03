export interface QueueStub extends Queue<unknown> {
  messages: unknown[];
}

export function stubQueue(): QueueStub {
  const messages: unknown[] = [];
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
