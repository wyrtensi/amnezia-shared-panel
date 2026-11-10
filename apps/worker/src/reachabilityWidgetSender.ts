import {
  buildWidgetData,
  serializeWidgetData,
  widgetCaption,
  widgetVersion,
  type WidgetInput,
} from "./reachabilityWidget.js";
import { REACHABILITY_WIDGET_HTML } from "./reachabilityWidgetHtml.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram.js";

/** The widget message the panel sent last, as stored. */
export type StoredWidget = { messageId: number; chatId: string; version: string };

export interface ReachabilityWidgetStore {
  /** The current state to draw, or null when there is no enabled probe. */
  loadWidgetSnapshot: (
    now: Date,
  ) => Promise<{ input: WidgetInput; widget: StoredWidget | null } | null>;
  /** A new widget message was sent. */
  saveWidget: (widget: StoredWidget, at: Date) => Promise<void>;
  /** The outcome of a refresh; `error` is null on success. Never a secret. */
  recordWidgetResult: (at: Date, error: string | null) => Promise<void>;
}

const NOT_FOUND = /message with widget to edit not found|message to edit not found/i;
const NOT_MODIFIED = /message is not modified/i;

const isRefusal = (error: unknown, pattern: RegExp) =>
  error instanceof TelegramApiError && pattern.test(error.description);

/**
 * Keep one status widget in the chat. The first refresh sends and pins it;
 * later ones only change its data. A deleted message, another chat or a new
 * HTML/caption sends a fresh one, pins it and unpins the old.
 */
export const createReachabilityWidget = ({
  api,
  chatId,
  store,
  now = () => new Date(),
  log = () => undefined,
}: {
  api: TelegramBotApi;
  chatId: string;
  store: ReachabilityWidgetStore;
  now?: () => Date;
  log?: (line: string) => void;
}) => {
  const bestEffort = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      log(`reachability widget: ${what}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  const refresh = async (): Promise<void> => {
    const at = now();
    const snapshot = await store.loadWidgetSnapshot(at);
    if (!snapshot) return;
    const data = serializeWidgetData(buildWidgetData(snapshot.input));
    const caption = widgetCaption(snapshot.input.label);
    const version = widgetVersion(caption);
    const previous = snapshot.widget;

    try {
      if (previous && previous.chatId === chatId && previous.version === version) {
        try {
          await api.call<boolean>("editMessageWidgetData", {
            chat_id: chatId,
            message_id: previous.messageId,
            chat_data: data,
          });
          await store.recordWidgetResult(at, null);
          return;
        } catch (error) {
          if (isRefusal(error, NOT_MODIFIED)) {
            await store.recordWidgetResult(at, null);
            return;
          }
          if (!isRefusal(error, NOT_FOUND)) throw error;
          log("reachability widget: the message is gone, sending a new one");
        }
      }

      const sent = await api.call<{ message_id: number }>("sendWidget", {
        chat_id: chatId,
        html: REACHABILITY_WIDGET_HTML,
        caption,
        chat_data: data,
      });
      // Stored before anything else can fail: a retry must edit this message,
      // not send a second one.
      await store.saveWidget({ messageId: sent.message_id, chatId, version }, at);
      await store.recordWidgetResult(at, null);
      await bestEffort("pin", () =>
        api.call("pinChatMessage", {
          chat_id: chatId,
          message_id: sent.message_id,
          disable_notification: true,
        }),
      );
      if (previous && previous.chatId === chatId && previous.messageId !== sent.message_id) {
        await bestEffort("unpin the old widget", () =>
          api.call("unpinChatMessage", { chat_id: chatId, message_id: previous.messageId }),
        );
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : "unknown error").slice(0, 300);
      await store.recordWidgetResult(at, message);
      throw error;
    }
  };

  return { refresh };
};

export type ReachabilityWidget = ReturnType<typeof createReachabilityWidget>;
