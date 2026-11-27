import type { Response } from 'express';
import type { AgentStreamEvent, AgentStreamSink } from '@crossmart/core';

/**
 * Shared SSE transport helper for Crossmart agent Supervisor streams.
 * Sets standard SSE headers, forwards `AgentStreamEvent` frames cleanly, handles client
 * disconnect via AbortController, and always closes the response stream.
 */
export function openAgentSseStream(res: Response): {
  sink: AgentStreamSink;
  signal: AbortSignal;
  close: () => void;
} {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  res.on('close', onClose);

  const sink: AgentStreamSink = {
    emit(event: AgentStreamEvent) {
      if (res.writableEnded) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
  };

  const close = () => {
    res.off('close', onClose);
    if (!res.writableEnded) {
      res.end();
    }
  };

  return { sink, signal: abortController.signal, close };
}
