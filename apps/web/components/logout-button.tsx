"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";
import type { LogoutMode } from "@/lib/logout";

/**
 * Sign out, by whichever route the visitor came in.
 *
 * `session` clears our own cookie through a form POST, so the logout cannot be
 * triggered by a cross-site GET. `cloudflare` navigates to Cloudflare Access's
 * own endpoint on this origin, which only accepts a GET - and which is why this
 * is a link rather than a form: there is no panel state to change, and the
 * alternative was showing no button at all to everyone behind Access.
 */
export function LogoutButton({ mode = "session" }: { mode?: LogoutMode }) {
  const { t } = useT();
  if (mode === "cloudflare") {
    return (
      <Button asChild variant="ghost" size="sm">
        <a href="/cdn-cgi/access/logout">
          <LogOut className="h-4 w-4" /> {t("nav.logout")}
        </a>
      </Button>
    );
  }
  return (
    <form action="/api/auth/logout" method="post">
      <Button type="submit" variant="ghost" size="sm">
        <LogOut className="h-4 w-4" /> {t("nav.logout")}
      </Button>
    </form>
  );
}
