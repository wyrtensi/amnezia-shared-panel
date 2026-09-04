import { EmployeeDashboard } from "@/components/employee/employee-dashboard";
import { resolveLogoutMode } from "@/lib/logout";

export default async function HomePage() {
  return <EmployeeDashboard logoutMode={await resolveLogoutMode()} />;
}
