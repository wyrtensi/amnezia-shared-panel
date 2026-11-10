import { describe, expect, it } from "vitest";

import { widgetCaption, widgetVersion, type WidgetInput } from "./reachabilityWidget.js";
import {
  createReachabilityWidget,
  type ReachabilityWidgetStore,
  type StoredWidget,
} from "./reachabilityWidgetSender.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram.js";

const input: WidgetInput = {
  label: "Testland",
  timeZone: "UTC",
  checkedAt: new Date("2026-11-10T14:51:00Z"),
  nextAt: null,
  staleLimitSec: 10_800,
  stale: false,
  mass: false,
  nodes: [],
};
const CURRENT = widgetVersion(widgetCaption("Testland"));

type Call = { method: string; body: Record<string, unknown> };

const fakeApi = (answers: Record<string, unknown[]> = {}) => {
  const calls: Call[] = [];
  const api: TelegramBotApi = {
    call: <T,>(method: string, body: Record<string, unknown>) => {
      calls.push({ method, body });
      const queue = answers[method] ?? [];
      const next = queue.length > 0 ? queue.shift() : method === "sendWidget" ? { message_id: 500 } : true;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as T);
    },
  };
  return { api, calls };
};

const fakeStore = (widget: StoredWidget | null, snapshot = true) => {
  const saved: StoredWidget[] = [];
  const results: Array<string | null> = [];
  const store: ReachabilityWidgetStore = {
    loadWidgetSnapshot: () => Promise.resolve(snapshot ? { input, widget } : null),
    saveWidget: (w) => {
      saved.push(w);
      return Promise.resolve();
    },
    recordWidgetResult: (_at, error) => {
      results.push(error);
      return Promise.resolve();
    },
  };
  return { store, saved, results };
};

const refusal = (method: string, description: string) =>
  new TelegramApiError(method, 400, `Bad Request: ${description}`);

describe("reachability widget", () => {
  it("sends, stores, then pins the first widget silently", async () => {
    const { api, calls } = fakeApi();
    const { store, saved, results } = fakeStore(null);
    await createReachabilityWidget({ api, chatId: "chat", store }).refresh();
    expect(calls.map((c) => c.method)).toEqual(["sendWidget", "pinChatMessage"]);
    expect(calls[0]?.body).toMatchObject({ chat_id: "chat", caption: "VPN из Testland" });
    expect(typeof calls[0]?.body.html).toBe("string");
    expect(JSON.parse(calls[0]?.body.chat_data as string)).toMatchObject({ v: 1, l: "Testland" });
    expect(calls[1]?.body).toEqual({ chat_id: "chat", message_id: 500, disable_notification: true });
    expect(saved).toEqual([{ messageId: 500, chatId: "chat", version: CURRENT }]);
    expect(results).toEqual([null]);
  });

  it("only edits the data of the current widget", async () => {
    const { api, calls } = fakeApi();
    const { store, saved } = fakeStore({ messageId: 9, chatId: "chat", version: CURRENT });
    await createReachabilityWidget({ api, chatId: "chat", store }).refresh();
    expect(calls.map((c) => c.method)).toEqual(["editMessageWidgetData"]);
    expect(calls[0]?.body).toMatchObject({ chat_id: "chat", message_id: 9 });
    expect(saved).toEqual([]);
  });

  it("treats an unchanged edit as success", async () => {
    const { api, calls } = fakeApi({
      editMessageWidgetData: [refusal("editMessageWidgetData", "message is not modified")],
    });
    const { store, results } = fakeStore({ messageId: 9, chatId: "chat", version: CURRENT });
    await createReachabilityWidget({ api, chatId: "chat", store }).refresh();
    expect(calls).toHaveLength(1);
    expect(results).toEqual([null]);
  });

  it("sends a new widget when the old message is gone, and unpins the old one", async () => {
    const { api, calls } = fakeApi({
      editMessageWidgetData: [
        refusal("editMessageWidgetData", "message with widget to edit not found"),
      ],
    });
    const { store, saved } = fakeStore({ messageId: 9, chatId: "chat", version: CURRENT });
    await createReachabilityWidget({ api, chatId: "chat", store }).refresh();
    expect(calls.map((c) => c.method)).toEqual([
      "editMessageWidgetData",
      "sendWidget",
      "pinChatMessage",
      "unpinChatMessage",
    ]);
    expect(calls[3]?.body).toEqual({ chat_id: "chat", message_id: 9 });
    expect(saved[0]?.messageId).toBe(500);
  });

  it("sends a new widget for a new template or another chat, without editing", async () => {
    for (const widget of [
      { messageId: 9, chatId: "chat", version: "old-version" },
      { messageId: 9, chatId: "other-chat", version: CURRENT },
    ]) {
      const { api, calls } = fakeApi();
      const { store } = fakeStore(widget);
      await createReachabilityWidget({ api, chatId: "chat", store }).refresh();
      expect(calls[0]?.method).toBe("sendWidget");
      // The old message in another chat is not touched.
      const unpins = calls.filter((c) => c.method === "unpinChatMessage");
      expect(unpins).toHaveLength(widget.chatId === "chat" ? 1 : 0);
    }
  });

  it("does not fail or resend when pinning fails", async () => {
    const lines: string[] = [];
    const { api, calls } = fakeApi({ pinChatMessage: [refusal("pinChatMessage", "not enough rights")] });
    const { store, saved, results } = fakeStore(null);
    await createReachabilityWidget({ api, chatId: "chat", store, log: (l) => lines.push(l) }).refresh();
    expect(calls.filter((c) => c.method === "sendWidget")).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(results).toEqual([null]);
    expect(lines.join("\n")).toContain("pin");
  });

  it("records and rethrows any other refusal, so the job retries", async () => {
    const { api } = fakeApi({ editMessageWidgetData: [refusal("editMessageWidgetData", "chat not found")] });
    const { store, results } = fakeStore({ messageId: 9, chatId: "chat", version: CURRENT });
    await expect(createReachabilityWidget({ api, chatId: "chat", store }).refresh()).rejects.toThrow(
      "chat not found",
    );
    expect(results[0]).toContain("chat not found");
  });

  it("does nothing without an enabled probe", async () => {
    const { api, calls } = fakeApi();
    const { store } = fakeStore(null, false);
    await createReachabilityWidget({ api, chatId: "chat", store }).refresh();
    expect(calls).toEqual([]);
  });
});
