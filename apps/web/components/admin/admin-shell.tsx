"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  FileText,
  KeyRound,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Users,
} from "lucide-react";
import { LanguageToggle } from "@/components/language-toggle";
import { Logo } from "@/components/logo";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import { AdminDataProvider } from "@/components/admin/admin-data";
import { VersionBadge } from "@/components/admin/version-badge";

const NAV = [
  { href: "/admin", label: "nav.overview", icon: Activity },
  { href: "/admin/users", label: "nav.users", icon: Users },
  { href: "/admin/nodes", label: "nav.nodes", icon: Server },
  { href: "/admin/policy", label: "nav.policy", icon: Settings },
  { href: "/admin/rules", label: "nav.rules", icon: Shield },
  { href: "/admin/audit", label: "nav.audit", icon: FileText },
];

export function AdminShell({
  children,
  canLogout = false,
}: {
  children: React.ReactNode;
  canLogout?: boolean;
}) {
  const pathname = usePathname();
  const { t } = useT();

  return (
    <AdminDataProvider>
      <div className="flex min-h-screen bg-muted/30">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
          <div className="px-4 py-4">
            <Logo className="h-11 w-auto" />
          </div>
          <nav className="flex-1 space-y-1 px-3 py-2">
            {NAV.map((item) => {
              const active =
                item.href === "/admin"
                  ? pathname === "/admin"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-primary/12 text-sidebar-primary"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {t(item.label)}
                </Link>
              );
            })}
          </nav>
          <div className="px-3 pt-3">
            <Button asChild variant="ghost" size="sm" className="w-full justify-start">
              <Link href="/" prefetch={false}>
                <KeyRound className="h-4 w-4" /> {t("admin.myKeys")}
              </Link>
            </Button>
          </div>
          <VersionBadge />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b bg-background/80 px-4 py-3 backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground md:hidden">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <h1 className="text-lg font-semibold">{t("admin.title")}</h1>
            </div>
            <div className="flex items-center gap-2">
              <LanguageToggle />
              <ThemeToggle />
              {canLogout ? <LogoutButton /> : null}
            </div>
          </header>

          {/* Mobile navigation */}
          <nav className="flex gap-1 overflow-x-auto border-b bg-background px-3 py-2 md:hidden">
            {NAV.map((item) => {
              const active =
                item.href === "/admin"
                  ? pathname === "/admin"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {t(item.label)}
                </Link>
              );
            })}
          </nav>

          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </AdminDataProvider>
  );
}
