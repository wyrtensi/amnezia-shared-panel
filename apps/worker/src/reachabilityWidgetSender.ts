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
 * shared widget it shows, or null for a widget of its own (one sent without
 * `is_shared`, including any sent before sharing existed). `sentAt` is null
 * for a message sent before the send time was recorded, which counts as old.
 */
export type WidgetMessage = {
  chatId: string;
  messageId: number;
  widgetId: string | null;
  sentAt: Date | null;
};

/**
 * The widget generation every chat shows, and where it was sent. `version`
 * is the HTML and caption of the current copies; `sharedId` is their shared
 * widget, or null when each chat holds a widget of its own.
 */
export type StoredWidget = {
  sharedId: string | null;
  version: string | null;
  messages: WidgetMessage[];
};

/** A copy that was just sent. */
export type SentWidgetMessage = WidgetMessage & { sentAt: Date };

export interface ReachabilityWidgetStore {
  /** The current state to draw, or null when there is no enabled probe. */
  loadWidgetSnapshot: (now: Date) => Promise<{ input: WidgetInput; widget: StoredWidget } | null>;
  /**
   * The first copy of a new generation was sent: the generation replaces the
   * stored one, and `message` is its first copy. One transaction, so a crash
   * cannot keep one without the other.
   */
  saveWidgetGeneration: (
    generation: { sharedId: string | null; version: string },
    message: SentWidgetMessage,
  ) => Promise<void>;
  /** A copy of the current generation was sent to a chat. */
  saveWidgetMessage: (message: SentWidgetMessage) => Promise<void>;
  /** The chat no longer gets the widget. */
  deleteWidgetMessage: (chatId: string) => Promise<void>;
  /** The outcome of a refresh; `error` is null on success. Never a secret. */
  recordWidgetResult: (at: Date, error: string | null) => Promise<void>;
}

const NOT_MODIFIED = /not[ _]modified/i;
const MESSAGE_GONE = /message with widget to edit not found|message to edit not found/i;
/**
 * Telegram no longer knows the shared widget. Its wording is not documented;
 * data errors (WIDGET_DATA_INVALID, ..._TOO_LARGE) must not match, or every
 * refresh would send a new widget.
 */
const SHARED_GONE = /widget.{0,40}not[ _]found|WIDGET_ID_INVALID|WIDGET_INVALID/i;
/**
 * Telegram refuses shared widgets for this bot (seen in production as
 * INPUT_MEDIA_WIDGET_NOT_ALLOWED while plain widgets still work).
 */
const SHARED_REFUSED = /WIDGET_NOT_ALLOWED|shared widgets? (are |is )?not (allowed|available|supported)/i;

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
 * Keep the status widget in every chat, pinned, with the same data.
 *
 * Shared mode (preferred): one shared widget (`sendWidget` with `is_shared`
 * to the first chat that takes it, `sendSharedWidget` to the others), and one
 * `editSharedWidgetData` call per refresh changes every copy. A new
 * HTML/caption, a chat taken off the list (so its copy stops changing) or a
 * shared widget Telegram no longer knows sends a new one.
 *
 * Per-chat mode: when Telegram refuses shared widgets, each chat gets a
 * widget of its own and each refresh edits each one (`editMessageWidgetData`);
 * a deleted message is sent again. The refusal is remembered for the life of
 * this process, so a restart tries sharing once more.
 *
 * In both, a chat without a current copy gets one, and so does a chat whose
 * copy is older than a day when a node alert came with the run. A new copy is
 * pinned and the chat's old one unpinned; a removed chat's copy is unpinned.
 * Telegram does not report a deleted copy of a shared widget, so that chat
 * gets a new copy only on one of the rules above.
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
  let sharingRefused = false;

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

    const outdated = (copy: WidgetMessage) =>
      reason.notice === true &&
      (copy.sentAt === null || at.getTime() - copy.sentAt.getTime() > WIDGET_RESEND_AFTER_MS);

    /** Unpin and forget the copies of chats taken off the list. */
    const dropRemoved = async () => {
      for (const copy of dropped) {
        await bestEffort("unpin the widget of a removed chat", () =>
          api.call("unpinChatMessage", { chat_id: copy.chatId, message_id: copy.messageId }),
        );
        await store.deleteWidgetMessage(copy.chatId);
      }
    };

    /**
     * Shared mode. "refused" when Telegram does not allow shared widgets;
     * "stop" when the refresh is over without retrying (a widget came back
     * without a shared id: every retry would send another one).
     */
    const refreshShared = async (): Promise<"done" | "refused" | "stop"> => {
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
      if (sharedId === null) {
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
            if (isRefusal(error, SHARED_REFUSED)) {
              log(`reachability widget: Telegram refuses shared widgets (${errorText(error)}), one widget per chat`);
              return "refused";
            }
            if (!isChatRefusal(error)) throw error;
            chatFailed(chatId, error);
            continue;
          }
          const id = sent.widget?.id;
          if (typeof id !== "string" || id === "") {
            failures.push("Telegram sendWidget returned no shared widget id");
            log("reachability widget: Telegram sendWidget returned no shared widget id");
            await bestEffort("delete the widget without a shared id", () =>
              api.call("deleteMessage", { chat_id: chatId, message_id: sent.message_id }),
            );
            return "stop";
          }
          const message = { chatId, messageId: sent.message_id, widgetId: id, sentAt: at };
          // Stored before anything else can fail: a retry must edit this
          // widget, not send a second one.
          await store.saveWidgetGeneration({ sharedId: id, version }, message);
          await pinned(message);
          sharedId = id;
          break;
        }
        if (sharedId === null) {
          throw new Error(`no chat took the widget (${failures.join("; ")})`.slice(0, 300));
        }
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
      return "done";
    };

    /** Per-chat mode: a widget of its own in each chat, edited one by one. */
    const refreshPerChat = async () => {
      // The stored generation is this one only when it is per-chat already.
      let generationSaved = stored.sharedId === null && stored.version === version;
      for (const chatId of recipients) {
        if (refused.has(chatId)) continue;
        const copy = copies.get(chatId);
        if (copy && generationSaved && copy.widgetId === null && !outdated(copy)) {
          try {
            await api.call<boolean>("editMessageWidgetData", {
              chat_id: chatId,
              message_id: copy.messageId,
              chat_data: data,
            });
            continue;
          } catch (error) {
            if (isRefusal(error, NOT_MODIFIED)) continue;
            if (!isRefusal(error, MESSAGE_GONE)) {
              if (!isChatRefusal(error)) throw error;
              chatFailed(chatId, error);
              continue;
            }
            log(`reachability widget: chat ${chatId}: the message is gone, sending a new one`);
          }
        }
        let sent: { message_id: number };
        try {
          sent = await api.call<{ message_id: number }>("sendWidget", {
            chat_id: chatId,
            html: REACHABILITY_WIDGET_HTML,
            caption,
            chat_data: data,
          });
        } catch (error) {
          if (!isChatRefusal(error)) throw error;
          chatFailed(chatId, error);
          continue;
        }
        const message = { chatId, messageId: sent.message_id, widgetId: null, sentAt: at };
        // Stored before anything else can fail: a retry must edit this
        // message, not send a second one.
        if (generationSaved) {
          await store.saveWidgetMessage(message);
        } else {
          await store.saveWidgetGeneration({ sharedId: null, version }, message);
          generationSaved = true;
        }
        await pinned(message);
      }
      if (!generationSaved) {
        throw new Error(`no chat took the widget (${failures.join("; ")})`.slice(0, 300));
      }
    };

    try {
      if (!sharingRefused) {
        const outcome = await refreshShared();
        if (outcome === "stop") {
          await store.recordWidgetResult(at, failures.join("; ").slice(0, 300));
          return;
        }
        if (outcome === "refused") sharingRefused = true;
      }
      if (sharingRefused) await refreshPerChat();
      await dropRemoved();
      await store.recordWidgetResult(at, failures.length > 0 ? failures.join("; ").slice(0, 300) : null);
    } catch (error) {
      await store.recordWidgetResult(at, errorText(error).slice(0, 300));
      throw error;
    }
  };

  return { refresh };
};

export type ReachabilityWidget = ReturnType<typeof createReachabilityWidget>;
