import { describe, expect, it, vi } from "vitest";
import type { QuotaRequestNotifyPayload } from "@amnezia/contracts";
import {
  createTelegramBotApi,
  createTelegramNotifier,
  TelegramApiError,
  formatQuotaRequestMessage,
  resolveTelegramConfig,
} from "./telegram.js";

const TOKEN = "123456:secret-token-value";

const payload: QuotaRequestNotifyPayload = {
  quotaRequestId: "req-1",
  email: "user@example.com",
  displayName: "Some User",
  requestedLimit: 8,
  nodeName: null,
  reason: "",
  createdAt: "2026-11-09T12:00:00.000Z",
};

describe("resolveTelegramConfig", () => {
  it("is off unless both the token and the chat are set", () => {
    expect(resolveTelegramConfig({})).toBeNull();
    expect(resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeNull();
    expect(resolveTelegramConfig({ TELEGRAM_CHAT_ID: "42" })).toBeNull();
    expect(
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: ` ${TOKEN} `,
        TELEGRAM_CHAT_ID: " 42 ",
      }),
    ).toEqual({ token: TOKEN, chatId: "42" });
  });
});

describe("formatQuotaRequestMessage", () => {
  it("names who asks, the limit, the scope and links the admin page", () => {
    const text = formatQuotaRequestMessage(payload, "https://panel.example.com/");
    expect(text).toContain("Some User (user@example.com)");
    expect(text).toContain("8");
    expect(text).toContain("все серверы");
    expect(text).toContain("https://panel.example.com/admin");
    expect(text).not.toContain("Причина");
  });

  it("shows the server and the reason when the request has them", () => {
    const text = formatQuotaRequestMessage(
      { ...payload, displayName: null, nodeName: "Server name 3", reason: "two laptops" },
      null,
    );
    expect(text).toContain("user@example.com");
    expect(text).not.toContain("(user@example.com)");
    expect(text).toContain("Server name 3");
    expect(text).toContain("Причина: two laptops");
    expect(text).not.toContain("/admin");
  });
});

describe("createTelegramNotifier", () => {
  it("posts plain text to the configured chat", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const notifier = createTelegramNotifier({
      token: TOKEN,
      chatId: "42",
      fetch: fetchMock,
    });

    await notifier.send("hello <b>");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      chat_id: "42",
      text: "hello <b>",
      disable_web_page_preview: true,
    });
    // Free text from users goes in as is: no parse_mode, nothing to escape.
    expect(body).not.toHaveProperty("parse_mode");
  });

  it("reports an API refusal without the token", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, description: `Unauthorized for bot${TOKEN}` }),
          { status: 401 },
        ),
      ),
    );
    const notifier = createTelegramNotifier({
      token: TOKEN,
      chatId: "42",
      fetch: fetchMock,
    });

    const error = await notifier.send("x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain("secret-token-value");
  });

  it("reports a network failure without the token", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(
        new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`),
      ),
    );
    const notifier = createTelegramNotifier({
      token: TOKEN,
      chatId: "42",
      fetch: fetchMock,
    });

    const error = await notifier.send("x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain("secret-token-value");
  });
});

describe("createTelegramBotApi", () => {
  it("posts the body to the method and returns the result", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
      ),
    );
    const api = createTelegramBotApi({ token: TOKEN, fetch: fetchMock });
    await expect(api.call("sendWidget", { chat_id: "42", html: "<b>x</b>" })).resolves.toEqual({
      message_id: 7,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendWidget`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "42", html: "<b>x</b>" });
  });

  it("keeps Telegram's description, never the token", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, description: `Bad Request: message is not modified bot${TOKEN}` }),
          { status: 400 },
        ),
      ),
    );
    const api = createTelegramBotApi({ token: TOKEN, fetch: fetchMock });
    const error = await api.call("editMessageWidgetData", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).description).toContain("message is not modified");
    expect(String(error)).toContain("400");
    expect(String(error)).not.toContain("secret-token-value");
  });

  it("reports a network failure by name only", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/x`)),
    );
    const api = createTelegramBotApi({ token: TOKEN, fetch: fetchMock });
    const error = await api.call("sendWidget", {}).catch((caught: unknown) => caught);
    expect(String(error)).toContain("TypeError");
    expect(String(error)).not.toContain("secret-token-value");
  });
});
