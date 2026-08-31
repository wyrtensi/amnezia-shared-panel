import { cookies } from "next/headers";
import { EmployeeDashboard } from "@/components/employee/employee-dashboard";
import { SESSION_COOKIE } from "@/lib/session";

export default async function HomePage() {
  // A direct (server-side Google) session → offer a logout button. On the
  // Cloudflare path there is no panel_session and sign-out is handled by CF.
  const canLogout = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  return <EmployeeDashboard canLogout={canLogout} />;
}
