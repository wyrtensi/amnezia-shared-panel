import type { QuotaRequestNotifyPayload } from "@amnezia/contracts";

/**
 * Operator notifications through a Telegram bot (Bot API `sendMessage`).
 *
 * Off unless both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set on the
 * worker. The token is part of every request URL, so no error this module
 * throws may carry the URL or a message that could echo it: the runner stores
 * a thrown message in `job_outbox.last_error`, which the admin UI shows.
 */

export type TelegramConfig = { token: string; chatId: string };

export type TelegramNotifier = { send: (text: string) => Promise<void> };

const SEND_TIMEOUT_MS = 10_000;

export const resolveTelegramConfig = (
  env: NodeJS.ProcessEnv,
): TelegramConfig | null => {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
};

const redact = (text: string, token: string): string =>
  text.split(token).join("<redacted>");

export const createTelegramNotifier = ({
  token,
  chatId,
  fetch: fetchImpl = fetch,
}: TelegramConfig & { fetch?: typeof fetch }): TelegramNotifier => ({
  send: async (text) => {
    let response: Response;
    try {
      response = await fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // No parse_mode: the text carries free user input, and plain text
          // needs no escaping.
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      // Only the error's name: a fetch failure message can contain the URL,
      // and a `cause` would carry that message into any log that prints it.
      const name = error instanceof Error ? error.name : "unknown error";
      // eslint-disable-next-line preserve-caught-error -- the cause can hold the bot token
      throw new Error(`Telegram sendMessage failed: ${name}`);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        description?: unknown;
      } | null;
      const description =
        typeof body?.description === "string"
          ? `: ${redact(body.description, token).slice(0, 200)}`
          : "";
      throw new Error(
        `Telegram sendMessage failed: HTTP ${response.status}${description}`,
      );
    }
  },
});

/** The operator-facing text for a new quota request (Russian, plain text). */
export const formatQuotaRequestMessage = (
  payload: QuotaRequestNotifyPayload,
  panelPublicUrl: string | null,
): string => {
  const who = payload.displayName
    ? `${payload.displayName} (${payload.email})`
    : payload.email;
  const lines = [
    "Запрос на увеличение лимита ключей",
    `Кто: ${who}`,
    `Просит: ${payload.requestedLimit}`,
    `Сервер: ${payload.nodeName ?? "все серверы"}`,
  ];
  const reason = payload.reason.trim();
  if (reason) lines.push(`Причина: ${reason}`);
  const base = panelPublicUrl?.trim().replace(/\/+$/, "");
  if (base) lines.push(`Рассмотреть: ${base}/admin`);
  return lines.join("\n");
};
