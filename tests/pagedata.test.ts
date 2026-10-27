import { describe, expect, it } from 'vitest';
import { conversationFromPath, hookPageData } from '../src/pagedata';

const ID = '6ad5c530-6c88-83ed-b5fb-0f8a118fe7ff';

describe('page data', () => {
  it('finds the chat id in the address', () => {
    expect(conversationFromPath(`/c/${ID}`)).toBe(ID);
    expect(conversationFromPath(`/g/g-abc-name/c/${ID}`)).toBe(ID);
    expect(conversationFromPath('/')).toBeNull();
    expect(conversationFromPath('/c/local-chatgpt%3A1a5b')).toBeNull();
  });

  it('restores chunks the page enqueues, in order, before the stream gets them', async () => {
    const win = { location: { pathname: `/c/${ID}` } } as unknown as Window & Record<string, any>;
    const asked: string[] = [];
    hookPageData(win, async (text, conversation) => {
      asked.push(conversation);
      // The first chunk answers last; order must still hold.
      await new Promise((r) => setTimeout(r, text.startsWith('A') ? 20 : 1));
      return text.replace('[PHONE_1]', '0730841471');
    });
    // What the page's own scripts do (see a capture of chatgpt.com).
    win.__reactRouterContext = { ssr: true };
    win.__reactRouterContext.stream = new ReadableStream<string>({
      start(controller) {
        win.__reactRouterContext.streamController = controller;
      },
    });
    win.__reactRouterContext.streamController.enqueue('A: [PHONE_1]');
    win.__reactRouterContext.streamController.enqueue('B: [PHONE_1]');
    win.__reactRouterContext.streamController.close();

    const reader = (win.__reactRouterContext.stream as ReadableStream<string>).getReader();
    const got: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(value);
    }
    expect(got).toEqual(['A: 0730841471', 'B: 0730841471']);
    expect(asked).toEqual([ID, ID]);
  });

  it('keeps a chunk when Veil gives nothing back', async () => {
    const win = { location: { pathname: `/c/${ID}` } } as unknown as Window & Record<string, any>;
    hookPageData(win, async () => null);
    win.__reactRouterContext = {};
    win.__reactRouterContext.stream = new ReadableStream<string>({
      start(c) {
        win.__reactRouterContext.streamController = c;
      },
    });
    win.__reactRouterContext.streamController.enqueue('[PHONE_1]');
    win.__reactRouterContext.streamController.close();
    const { value } = await (win.__reactRouterContext.stream as ReadableStream<string>).getReader().read();
    expect(value).toBe('[PHONE_1]');
  });
});
