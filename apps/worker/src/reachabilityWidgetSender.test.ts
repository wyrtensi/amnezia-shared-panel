import { describe, expect, it } from "vitest";

import { widgetCaption, widgetVersion, type WidgetInput } from "./reachabilityWidget.js";
import {
  createReachabilityWidget,
  type ReachabilityWidgetStore,
  type SentWidgetMessage,
  type StoredWidget,
  type WidgetMessage,
  WIDGET_RESEND_AFTER_MS,
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
const NOW = new Date("2026-11-18T12:00:00Z");
const now = () => NOW;
const FRESH = new Date("2026-11-18T06:00:00Z");
const OLD = new Date("2026-11-17T11:59:00Z");
const SHARED = "shared-1";

type Call = { method: string; body: Record<string, unknown> };

/** Message ids count up from 500 per send; a new shared widget is "shared-new". */
const fakeApi = (answers: Record<string, unknown[]> = {}) => {
  const calls: Call[] = [];
  let nextMessageId = 500;
  const api: TelegramBotApi = {
    call: <T,>(method: string, body: Record<string, unknown>) => {
      calls.push({ method, body });
      const queue = answers[method] ?? [];
      const next =
        queue.length > 0
          ? queue.shift()
          : method === "sendWidget"
            ? { message_id: nextMessageId++, widget: { id: "shared-new" } }
            : method === "sendSharedWidget"
              ? { message_id: nextMessageId++ }
              : true;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as T);
    },
  };
  return { api, calls };
};

const fakeStore = (widget: StoredWidget = { sharedId: null, version: null, messages: [] }, snapshot = true) => {
  const shared: Array<{ sharedId: string; version: string }> = [];
  const saved: SentWidgetMessage[] = [];
  const deleted: string[] = [];
  const results: Array<string | null> = [];
  const store: ReachabilityWidgetStore = {
    loadWidgetSnapshot: () => Promise.resolve(snapshot ? { input, widget } : null),
    saveSharedWidget: (s, message) => {
      shared.push(s);
      saved.push(message);
      return Promise.resolve();
    },
    saveWidgetMessage: (message) => {
      saved.push(message);
      return Promise.resolve();
    },
    deleteWidgetMessage: (chatId) => {
      deleted.push(chatId);
      return Promise.resolve();
    },
    recordWidgetResult: (_at, error) => {
      results.push(error);
      return Promise.resolve();
    },
  };
  return { store, shared, saved, deleted, results };
};

const copy = (chatId: string, messageId: number, sentAt: Date | null = FRESH, widgetId: string | null = SHARED): WidgetMessage => ({
  chatId,
  messageId,
  widgetId,
  sentAt,
});

const current = (...messages: WidgetMessage[]): StoredWidget => ({ sharedId: SHARED, version: CURRENT, messages });

const refusal = (method: string, description: string, status = 400) =>
  new TelegramApiError(method, status, `${status === 403 ? "Forbidden" : "Bad Request"}: ${description}`);

const methods = (calls: Call[]) => calls.map((c) => c.method);

describe("reachability widget", () => {
  it("sends one shared widget to the first chat and the same widget to the others, pinning each", async () => {
    const { api, calls } = fakeApi();
    const { store, shared, saved, results } = fakeStore();
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh();
    expect(methods(calls)).toEqual(["sendWidget", "pinChatMessage", "sendSharedWidget", "pinChatMessage"]);
    expect(calls[0]?.body).toMatchObject({ chat_id: "chat-a", caption: "VPN из Testland", is_shared: true });
    expect(typeof calls[0]?.body.html).toBe("string");
    expect(calls[0]?.body).not.toHaveProperty("chat_data");
    expect(JSON.parse(calls[0]?.body.public_data as string)).toMatchObject({ v: 4, l: "Testland" });
    expect(calls[1]?.body).toEqual({ chat_id: "chat-a", message_id: 500, disable_notification: true });
    expect(calls[2]?.body).toEqual({ chat_id: "chat-b", widget_id: "shared-new", caption: "VPN из Testland" });
    expect(calls[3]?.body).toEqual({ chat_id: "chat-b", message_id: 501, disable_notification: true });
    expect(shared).toEqual([{ sharedId: "shared-new", version: CURRENT }]);
    expect(saved).toEqual([
      { chatId: "chat-a", messageId: 500, widgetId: "shared-new", sentAt: NOW },
      { chatId: "chat-b", messageId: 501, widgetId: "shared-new", sentAt: NOW },
    ]);
    expect(results).toEqual([null]);
  });

  it("changes the data of every copy with one call", async () => {
    const { api, calls } = fakeApi();
    const { store, saved } = fakeStore(current(copy("chat-a", 9), copy("chat-b", 10)));
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store }).refresh();
    expect(methods(calls)).toEqual(["editSharedWidgetData"]);
    expect(calls[0]?.body).toMatchObject({ widget_id: SHARED });
    expect(JSON.parse(calls[0]?.body.public_data as string)).toMatchObject({ v: 4 });
    expect(saved).toEqual([]);
  });

  it("treats an unchanged edit as success", async () => {
    for (const description of ["message is not modified", "WIDGET_DATA_NOT_MODIFIED"]) {
      const { api, calls } = fakeApi({
        editSharedWidgetData: [refusal("editSharedWidgetData", description)],
      });
      const { store, results } = fakeStore(current(copy("chat-a", 9)));
      await createReachabilityWidget({ api, chatIds: ["chat-a"], store }).refresh();
      expect(calls).toHaveLength(1);
      expect(results).toEqual([null]);
    }
  });

  it("sends the current widget to a chat added to the list, leaving the others alone", async () => {
    const { api, calls } = fakeApi();
    const { store, shared, saved } = fakeStore(current(copy("chat-a", 9)));
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh();
    expect(methods(calls)).toEqual(["editSharedWidgetData", "sendSharedWidget", "pinChatMessage"]);
    expect(calls[1]?.body).toMatchObject({ chat_id: "chat-b", widget_id: SHARED });
    expect(shared).toEqual([]);
    expect(saved).toEqual([{ chatId: "chat-b", messageId: 500, widgetId: SHARED, sentAt: NOW }]);
  });

  it("sends a new shared widget when a chat is taken off the list, so its copy stops changing", async () => {
    const { api, calls } = fakeApi();
    const { store, shared, deleted } = fakeStore(current(copy("chat-a", 9), copy("chat-gone", 10)));
    await createReachabilityWidget({ api, chatIds: ["chat-a"], store, now }).refresh();
    expect(methods(calls)).toEqual(["sendWidget", "pinChatMessage", "unpinChatMessage", "unpinChatMessage"]);
    // No edit of the old widget: the removed chat's copy keeps the old data.
    expect(calls.some((c) => c.method === "editSharedWidgetData")).toBe(false);
    expect(calls[2]?.body).toEqual({ chat_id: "chat-a", message_id: 9 });
    expect(calls[3]?.body).toEqual({ chat_id: "chat-gone", message_id: 10 });
    expect(shared).toEqual([{ sharedId: "shared-new", version: CURRENT }]);
    expect(deleted).toEqual(["chat-gone"]);
  });

  it("sends a new shared widget for a new template and unpins every old copy", async () => {
    const { api, calls } = fakeApi();
    const { store, shared } = fakeStore({
      sharedId: SHARED,
      version: "old-version",
      messages: [copy("chat-a", 9), copy("chat-b", 10)],
    });
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh();
    expect(methods(calls)).toEqual([
      "sendWidget",
      "pinChatMessage",
      "unpinChatMessage",
      "sendSharedWidget",
      "pinChatMessage",
      "unpinChatMessage",
    ]);
    expect(calls[2]?.body).toEqual({ chat_id: "chat-a", message_id: 9 });
    expect(calls[5]?.body).toEqual({ chat_id: "chat-b", message_id: 10 });
    expect(shared).toHaveLength(1);
  });

  it("replaces the message sent before the widget was shared", async () => {
    const { api, calls } = fakeApi();
    const { store, saved } = fakeStore({
      sharedId: null,
      version: null,
      messages: [copy("chat-a", 9, null, null)],
    });
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh();
    expect(methods(calls)).toEqual([
      "sendWidget",
      "pinChatMessage",
      "unpinChatMessage",
      "sendSharedWidget",
      "pinChatMessage",
    ]);
    expect(calls[2]?.body).toEqual({ chat_id: "chat-a", message_id: 9 });
    expect(saved.map((m) => m.chatId)).toEqual(["chat-a", "chat-b"]);
  });

  it("sends a new shared widget when Telegram no longer knows the old one", async () => {
    for (const description of ["WIDGET_ID_INVALID", "WIDGET_NOT_FOUND", "shared widget not found"]) {
      const { api, calls } = fakeApi({
        editSharedWidgetData: [refusal("editSharedWidgetData", description)],
      });
      const { store, shared } = fakeStore(current(copy("chat-a", 9)));
      await createReachabilityWidget({ api, chatIds: ["chat-a"], store, now }).refresh();
      expect(methods(calls)).toEqual(["editSharedWidgetData", "sendWidget", "pinChatMessage", "unpinChatMessage"]);
      expect(shared).toEqual([{ sharedId: "shared-new", version: CURRENT }]);
    }
  });

  it("never sends a new widget over a data error", async () => {
    const { api, calls } = fakeApi({
      editSharedWidgetData: [refusal("editSharedWidgetData", "WIDGET_DATA_INVALID")],
    });
    const { store, results } = fakeStore(current(copy("chat-a", 9)));
    await expect(createReachabilityWidget({ api, chatIds: ["chat-a"], store }).refresh()).rejects.toThrow(
      "WIDGET_DATA_INVALID",
    );
    expect(methods(calls)).toEqual(["editSharedWidgetData"]);
    expect(results[0]).toContain("WIDGET_DATA_INVALID");
  });

  it("keeps serving the other chats when one refuses, and records it", async () => {
    const lines: string[] = [];
    const { api, calls } = fakeApi({
      sendWidget: [refusal("sendWidget", "bot can't initiate conversation with a user", 403)],
    });
    const { store, saved, results } = fakeStore();
    await createReachabilityWidget({
      api,
      chatIds: ["chat-a", "chat-b"],
      store,
      now,
      log: (l) => lines.push(l),
    }).refresh();
    // chat-a refused the new widget; chat-b got it and chat-a is not asked again.
    expect(methods(calls)).toEqual(["sendWidget", "sendWidget", "pinChatMessage"]);
    expect(calls[1]?.body).toMatchObject({ chat_id: "chat-b", is_shared: true });
    expect(saved.map((m) => m.chatId)).toEqual(["chat-b"]);
    expect(results[0]).toContain("chat chat-a");
    expect(lines.join("\n")).toContain("chat-a");
  });

  it("tries a refusing chat again on the next refresh", async () => {
    const { api, calls } = fakeApi({
      sendSharedWidget: [refusal("sendSharedWidget", "bot was blocked by the user", 403)],
    });
    const { store, saved, results } = fakeStore(current(copy("chat-a", 9)));
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh();
    expect(methods(calls)).toEqual(["editSharedWidgetData", "sendSharedWidget"]);
    expect(saved).toEqual([]);
    expect(results[0]).toContain("blocked");
  });

  it("fails the refresh when no chat takes a new widget", async () => {
    const { api } = fakeApi({
      sendWidget: [refusal("sendWidget", "chat not found"), refusal("sendWidget", "chat not found")],
    });
    const { store, results } = fakeStore();
    await expect(
      createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh(),
    ).rejects.toThrow("no chat took the widget");
    expect(results[0]).toContain("no chat took the widget");
  });

  it("removes a widget sent without a shared id and does not retry, so retries cannot pile up messages", async () => {
    const { api, calls } = fakeApi({ sendWidget: [{ message_id: 500 }] });
    const { store, shared, saved, results } = fakeStore();
    await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh();
    expect(methods(calls)).toEqual(["sendWidget", "deleteMessage"]);
    expect(calls[1]?.body).toEqual({ chat_id: "chat-a", message_id: 500 });
    expect(shared).toEqual([]);
    expect(saved).toEqual([]);
    expect(results[0]).toContain("no shared widget id");
  });

  it("does not fail or resend when pinning fails", async () => {
    const lines: string[] = [];
    const { api, calls } = fakeApi({ pinChatMessage: [refusal("pinChatMessage", "not enough rights")] });
    const { store, saved, results } = fakeStore();
    await createReachabilityWidget({ api, chatIds: ["chat-a"], store, log: (l) => lines.push(l) }).refresh();
    expect(calls.filter((c) => c.method === "sendWidget")).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(results).toEqual([null]);
    expect(lines.join("\n")).toContain("pin");
  });

  it("records and rethrows a rate limit or server error, so the job retries", async () => {
    for (const status of [429, 500]) {
      const { api } = fakeApi({
        editSharedWidgetData: [new TelegramApiError("editSharedWidgetData", status, "Too Many Requests")],
      });
      const { store, results } = fakeStore(current(copy("chat-a", 9)));
      await expect(createReachabilityWidget({ api, chatIds: ["chat-a"], store }).refresh()).rejects.toThrow(
        "Too Many Requests",
      );
      expect(results[0]).toContain("Too Many Requests");
    }
  });

  it("does not treat a rate-limited copy as one chat's problem", async () => {
    const { api } = fakeApi({
      sendSharedWidget: [new TelegramApiError("sendSharedWidget", 429, "Too Many Requests: retry after 3")],
    });
    const { store } = fakeStore(current(copy("chat-a", 9)));
    await expect(
      createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh(),
    ).rejects.toThrow("Too Many Requests");
  });

  describe("after a node alert", () => {
    it("sends a new copy only to chats whose copy is older than a day", async () => {
      const { api, calls } = fakeApi();
      const { store, shared, saved } = fakeStore(current(copy("chat-a", 9, OLD), copy("chat-b", 10, FRESH)));
      await createReachabilityWidget({ api, chatIds: ["chat-a", "chat-b"], store, now }).refresh({ notice: true });
      expect(methods(calls)).toEqual([
        "editSharedWidgetData",
        "sendSharedWidget",
        "pinChatMessage",
        "unpinChatMessage",
      ]);
      expect(calls[1]?.body).toMatchObject({ chat_id: "chat-a", widget_id: SHARED });
      expect(calls[3]?.body).toEqual({ chat_id: "chat-a", message_id: 9 });
      expect(shared).toEqual([]);
      expect(saved).toEqual([{ chatId: "chat-a", messageId: 500, widgetId: SHARED, sentAt: NOW }]);
    });

    it("treats a copy without a send time as old", async () => {
      const { api, calls } = fakeApi();
      const { store } = fakeStore(current(copy("chat-a", 9, null)));
      await createReachabilityWidget({ api, chatIds: ["chat-a"], store, now }).refresh({ notice: true });
      expect(methods(calls)).toContain("sendSharedWidget");
    });

    it("leaves a copy sent within the day", async () => {
      const { api, calls } = fakeApi();
      const { store, saved } = fakeStore(current(copy("chat-a", 9, FRESH)));
      await createReachabilityWidget({ api, chatIds: ["chat-a"], store, now }).refresh({ notice: true });
      expect(methods(calls)).toEqual(["editSharedWidgetData"]);
      expect(saved).toEqual([]);
    });

    it("leaves a copy at exactly one day", async () => {
      const { api, calls } = fakeApi();
      const { store } = fakeStore(current(copy("chat-a", 9, new Date(NOW.getTime() - WIDGET_RESEND_AFTER_MS))));
      await createReachabilityWidget({ api, chatIds: ["chat-a"], store, now }).refresh({ notice: true });
      expect(methods(calls)).toEqual(["editSharedWidgetData"]);
    });
  });

  it("only edits old copies when no alert came with the run", async () => {
    for (const sentAt of [OLD, null]) {
      const { api, calls } = fakeApi();
      const { store, saved } = fakeStore(current(copy("chat-a", 9, sentAt)));
      const widget = createReachabilityWidget({ api, chatIds: ["chat-a"], store, now });
      await widget.refresh();
      await widget.refresh({ notice: false });
      expect(methods(calls)).toEqual(["editSharedWidgetData", "editSharedWidgetData"]);
      expect(saved).toEqual([]);
    }
  });

  it("does nothing without an enabled probe", async () => {
    const { api, calls } = fakeApi();
    const { store } = fakeStore(undefined, false);
    await createReachabilityWidget({ api, chatIds: ["chat-a"], store }).refresh();
    expect(calls).toEqual([]);
  });
});
