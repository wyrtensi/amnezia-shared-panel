# Local container stack

1. Copy `.env.example` to `.env` and replace every placeholder.
2. Start the stack with `docker compose --env-file .env up --build`.
3. Open `http://127.0.0.1:3000`.

The database is not published to the host. The control API and web ports bind to loopback only. Development identity is injected by the server-side web proxy and is unavailable when the control API runs in production mode.
