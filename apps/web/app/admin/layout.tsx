import { redirect } from "next/navigation";
import { getMe } from "@/lib/server-api";
import { AdminShell } from "@/components/admin/admin-shell";

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
  return <AdminShell>{children}</AdminShell>;
}
