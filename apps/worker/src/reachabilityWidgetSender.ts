import {
  buildWidgetData,
  serializeWidgetData,
  widgetCaption,
  widgetVersion,
  type WidgetInput,
} from "./reachabilityWidget.js";
import { REACHABILITY_WIDGET_HTML } from "./reachabilityWidgetHtml.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram.js";

/**
 * One copy of the status widget in one chat, as stored. `widgetId` is the
 * shared widget it shows: null for a message sent before the widget was
 * shared. `sentAt` is null for a message sent before the send time was
 * recorded. Both count as a copy to replace.
 */
export type WidgetMessage = {
  chatId: string;
  messageId: number;
  widgetId: string | null;
  sentAt: Date | null;
};

/**
 * The shared widget every chat shows, and where it was sent. `sharedId` and
 * `version` are null until the first shared widget is sent.
 */
export type StoredWidget = {
  sharedId: string | null;
  version: string | null;
  messages: WidgetMessage[];
};

/** A copy that was just sent. */
export type SentWidgetMessage = WidgetMessage & { widgetId: string; sentAt: Date };

export interface ReachabilityWidgetStore {
  /** The current state to draw, or null when there is no enabled probe. */
  loadWidgetSnapshot: (now: Date) => Promise<{ input: WidgetInput; widget: StoredWidget } | null>;
  /**
   * A new shared widget was sent: it replaces the stored one, and `message`
   * is its first copy. One transaction, so a crash cannot keep one without
   * the other.
   */
  saveSharedWidget: (shared: { sharedId: string; version: string }, message: SentWidgetMessage) => Promise<void>;
  /** A copy of the current shared widget was sent to a chat. */
  saveWidgetMessage: (message: SentWidgetMessage) => Promise<void>;
  /** The chat no longer gets the widget. */
  deleteWidgetMessage: (chatId: string) => Promise<void>;
  /** The outcome of a refresh; `error` is null on success. Never a secret. */
  recordWidgetResult: (at: Date, error: string | null) => Promise<void>;
}

const NOT_MODIFIED = /not[ _]modified/i;
/**
 * Telegram no longer knows the shared widget. Its wording is not documented;
 * data errors (WIDGET_DATA_INVALID, ..._TOO_LARGE) must not match, or every
 * refresh would send a new widget.
 */
const SHARED_GONE = /widget.{0,40}not[ _]found|WIDGET_ID_INVALID|WIDGET_INVALID/i;

/**
 * After a node alert, a copy older than this is sent again rather than left
 * in place, so it stays near the newest messages; an old widget once stopped
 * drawing about a week after it was sent (cause unknown).
 */
export const WIDGET_RESEND_AFTER_MS = 24 * 60 * 60 * 1_000;

/** What queued the refresh. */
export type WidgetRefreshReason = {
  /** The same run sent a node unavailable/back alert. */
  notice?: boolean;
};

const isRefusal = (error: unknown, pattern: RegExp) =>
  error instanceof TelegramApiError && pattern.test(error.description);

/**
 * A refusal about one chat (blocked bot, chat not found, the person never
 * started the bot): the other chats still get the widget, and this one is
 * tried again on the next refresh. Rate limits, server errors and network
 * failures are not: the job retries.
 */
const isChatRefusal = (error: unknown): error is TelegramApiError =>
  error instanceof TelegramApiError &&
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 429;

const errorText = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

/**
 * Keep one shared status widget in every chat. The first refresh sends it
 * (`sendWidget` with `is_shared`) to one chat and the same widget
 * (`sendSharedWidget`) to the others, pinning each copy; later refreshes
 * change its data once for every copy (`editSharedWidgetData`).
 *
 * A new HTML/caption, a chat taken off the list (so its copy stops updating)
 * or a widget Telegram no longer knows sends a new shared widget to every
 * chat. A chat without a copy of the current widget gets one; so does a chat
 * whose copy is older than a day when a node alert came with the run. A new
 * copy is pinned and the chat's old one unpinned.
 *
 * Telegram does not report a copy a person deleted: the shared widget lives
 * on, so that chat gets a new copy only on the next rule above.
 */
export const createReachabilityWidget = ({
  api,
  chatIds,
  store,
  now = () => new Date(),
  log = () => undefined,
}: {
  api: TelegramBotApi;
  /** Every chat that gets the widget, in order; the first one gets a new widget first. */
  chatIds: readonly string[];
  store: ReachabilityWidgetStore;
  now?: () => Date;
  log?: (line: string) => void;
}) => {
  const recipients = [...new Set(chatIds)];

  const bestEffort = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      log(`reachability widget: ${what}: ${errorText(error)}`);
    }
  };

  const refresh = async (reason: WidgetRefreshReason = {}): Promise<void> => {
    const at = now();
    const snapshot = await store.loadWidgetSnapshot(at);
    if (!snapshot) return;
    const data = serializeWidgetData(buildWidgetData(snapshot.input));
    const caption = widgetCaption(snapshot.input.label);
    const version = widgetVersion(caption);
    const stored = snapshot.widget;
    const copies = new Map(stored.messages.map((message) => [message.chatId, message]));
    const dropped = stored.messages.filter((message) => !recipients.includes(message.chatId));
    const failures: string[] = [];
    const refused = new Set<string>();

    const chatFailed = (chatId: string, error: TelegramApiError) => {
      refused.add(chatId);
      failures.push(`chat ${chatId}: ${error.description}`);
      log(`reachability widget: chat ${chatId}: ${error.message}`);
    };

    /** Pin a new copy and unpin the chat's old one; neither ever resends. */
    const pinned = async (message: SentWidgetMessage) => {
      const previous = copies.get(message.chatId);
      copies.set(message.chatId, message);
      await bestEffort("pin", () =>
        api.call("pinChatMessage", {
          chat_id: message.chatId,
          message_id: message.messageId,
          disable_notification: true,
        }),
      );
      if (previous && previous.messageId !== message.messageId) {
        await bestEffort("unpin the old widget", () =>
          api.call("unpinChatMessage", { chat_id: message.chatId, message_id: previous.messageId }),
        );
      }
    };

    /**
     * Send a new shared widget to the first chat that takes it. Null when
     * Telegram sent a widget without a shared id: that message is removed and
     * the refresh is not retried, since every retry would send another one.
     */
    const sendShared = async (): Promise<string | null> => {
      for (const chatId of recipients) {
        let sent: { message_id: number; widget?: { id?: unknown } };
        try {
          sent = await api.call<{ message_id: number; widget?: { id?: unknown } }>("sendWidget", {
            chat_id: chatId,
            html: REACHABILITY_WIDGET_HTML,
            caption,
            public_data: data,
            is_shared: true,
          });
        } catch (error) {
          if (!isChatRefusal(error)) throw error;
          chatFailed(chatId, error);
          continue;
        }
        const sharedId = sent.widget?.id;
        if (typeof sharedId !== "string" || sharedId === "") {
          failures.push("Telegram sendWidget returned no shared widget id");
          log("reachability widget: Telegram sendWidget returned no shared widget id");
          await bestEffort("delete the widget without a shared id", () =>
            api.call("deleteMessage", { chat_id: chatId, message_id: sent.message_id }),
          );
          return null;
        }
        const message = { chatId, messageId: sent.message_id, widgetId: sharedId, sentAt: at };
        // Stored before anything else can fail: a retry must edit this
        // widget, not send a second one.
        await store.saveSharedWidget({ sharedId, version }, message);
        await pinned(message);
        return sharedId;
      }
      throw new Error(`no chat took the widget (${failures.join("; ")})`.slice(0, 300));
    };

    const outdated = (copy: WidgetMessage) =>
      reason.notice === true &&
      (copy.sentAt === null || at.getTime() - copy.sentAt.getTime() > WIDGET_RESEND_AFTER_MS);

    try {
      let sharedId =
        stored.sharedId !== null && stored.version === version && dropped.length === 0
          ? stored.sharedId
          : null;
      if (sharedId !== null) {
        try {
          await api.call<boolean>("editSharedWidgetData", { widget_id: sharedId, public_data: data });
        } catch (error) {
          if (isRefusal(error, SHARED_GONE)) {
            log("reachability widget: the shared widget is gone, sending a new one");
            sharedId = null;
          } else if (!isRefusal(error, NOT_MODIFIED)) {
            throw error;
          }
        }
      }
      if (sharedId === null) sharedId = await sendShared();
      if (sharedId === null) {
        await store.recordWidgetResult(at, failures.join("; ").slice(0, 300));
        return;
      }

      for (const chatId of recipients) {
        if (refused.has(chatId)) continue;
        const copy = copies.get(chatId);
        if (copy && copy.widgetId === sharedId && !outdated(copy)) continue;
        let sent: { message_id: number };
        try {
          sent = await api.call<{ message_id: number }>("sendSharedWidget", {
            chat_id: chatId,
            widget_id: sharedId,
            caption,
          });
        } catch (error) {
          if (!isChatRefusal(error)) throw error;
          chatFailed(chatId, error);
          continue;
        }
        const message = { chatId, messageId: sent.message_id, widgetId: sharedId, sentAt: at };
        await store.saveWidgetMessage(message);
        await pinned(message);
      }

      // The new shared widget is the only one edited from now on, so a copy
      // left in a chat that was taken off the list no longer changes.
      for (const copy of dropped) {
        await bestEffort("unpin the widget of a removed chat", () =>
          api.call("unpinChatMessage", { chat_id: copy.chatId, message_id: copy.messageId }),
        );
        await store.deleteWidgetMessage(copy.chatId);
      }

      await store.recordWidgetResult(at, failures.length > 0 ? failures.join("; ").slice(0, 300) : null);
    } catch (error) {
      await store.recordWidgetResult(at, errorText(error).slice(0, 300));
      throw error;
    }
  };

  return { refresh };
};

export type ReachabilityWidget = ReturnType<typeof createReachabilityWidget>;
