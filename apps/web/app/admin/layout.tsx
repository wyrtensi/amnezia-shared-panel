import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/server-api";
import { AdminShell } from "@/components/admin/admin-shell";
import { SESSION_COOKIE } from "@/lib/session";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getMe();
  // Non-admins never see the admin UI; the API also enforces this with 403.
  if (!me || me.role !== "admin") {
    redirect("/");
  }
  // A direct (server-side Google) session → offer a logout button (see page.tsx).
  const canLogout = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  return <AdminShell canLogout={canLogout}>{children}</AdminShell>;
}
