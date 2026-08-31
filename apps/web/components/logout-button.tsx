"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";

/**
 * Sign out of the direct (server-side Google) session. Rendered only when a
 * panel_session cookie is present — on the Cloudflare path there is no panel
 * session to clear (users sign out through Cloudflare Access). A form POST so
 * the logout cannot be triggered by a cross-site GET.
 */
export function LogoutButton() {
  const { t } = useT();
  return (
    <form action="/api/auth/logout" method="post">
      <Button type="submit" variant="ghost" size="sm">
        <LogOut className="h-4 w-4" /> {t("nav.logout")}
      </Button>
    </form>
  );
}
