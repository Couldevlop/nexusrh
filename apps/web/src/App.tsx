import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { queryClient } from '@/lib/queryClient'

// Layouts
import { AppLayout } from '@/layouts/AppLayout'
import { AuthLayout } from '@/layouts/AuthLayout'
import { KioskLayout } from '@/layouts/KioskLayout'
import { PlatformLayout } from '@/layouts/PlatformLayout'
import { EmployeeLayout } from '@/layouts/EmployeeLayout'

// Guards
import { RoleGuard } from '@/guards/RoleGuard'

// Auth pages
import { LoginPage } from '@/pages/auth/LoginPage'
import { MfaPage } from '@/pages/auth/MfaPage'

// Platform pages (super_admin)
import { PlatformDashboardPage } from '@/pages/platform/PlatformDashboardPage'
import { PlatformTenantsPage } from '@/pages/platform/PlatformTenantsPage'
import { PlatformLogsPage } from '@/pages/platform/PlatformLogsPage'
import { PlatformSettingsPage } from '@/pages/platform/PlatformSettingsPage'
import { PlatformOnboardingPage } from '@/pages/platform/PlatformOnboardingPage'

// App pages (admin / hr / manager)
import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { EmployeesPage } from '@/pages/employees/EmployeesPage'
import { EmployeeDetailPage } from '@/pages/employees/EmployeeDetailPage'
import { EmployeeNewPage } from '@/pages/employees/EmployeeNewPage'
import { OrgChartPage } from '@/pages/employees/OrgChartPage'
import { PayrollPage } from '@/pages/payroll/PayrollPage'
import { PaySlipsPage } from '@/pages/payroll/PaySlipsPage'
import { AbsencesPage } from '@/pages/absences/AbsencesPage'
import { RecruitmentPage } from '@/pages/recruitment/RecruitmentPage'
import { TrainingPage } from '@/pages/training/TrainingPage'
import { ExpensesPage } from '@/pages/expenses/ExpensesPage'
import { ReportingPage } from '@/pages/reporting/ReportingPage'
import { SelfServicePage } from '@/pages/self-service/SelfServicePage'
import { SettingsPage } from '@/pages/settings/SettingsPage'

// Employee self-service pages (espace employé)
import { MonEspacePage } from '@/pages/mon-espace/MonEspacePage'
import { MesAbsencesPage } from '@/pages/mon-espace/MesAbsencesPage'
import { MesBulletinsPage } from '@/pages/mon-espace/MesBulletinsPage'
import { MesNotesDeFraisPage } from '@/pages/mon-espace/MesNotesDeFraisPage'
import { MaFormationPage } from '@/pages/mon-espace/MaFormationPage'
import { MonProfilPage } from '@/pages/mon-espace/MonProfilPage'
import { MonEntretienPage } from '@/pages/mon-espace/MonEntretienPage'
import { CareersPage } from '@/pages/careers/CareersPage'

// Root redirect component — routes intelligemment selon le rôle
import { RootRedirect } from '@/components/RootRedirect'

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Auth routes */}
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/mfa" element={<MfaPage />} />
          </Route>

          {/* Root redirect — redirige selon le rôle */}
          <Route path="/" element={<RootRedirect />} />

          {/* ── ONBOARDING super_admin (sans layout, page pleine) ── */}
          <Route
            element={
              <RoleGuard allowedRoles={['super_admin']} redirectTo="/login">
                <PlatformOnboardingPage />
              </RoleGuard>
            }
          >
            <Route path="/platform/onboarding" element={<PlatformOnboardingPage />} />
          </Route>

          {/* ── PLATEFORME (super_admin uniquement) ── */}
          <Route
            element={
              <RoleGuard allowedRoles={['super_admin']} redirectTo="/dashboard">
                <PlatformLayout />
              </RoleGuard>
            }
          >
            <Route path="/platform/dashboard" element={<PlatformDashboardPage />} />
            <Route path="/platform/tenants" element={<PlatformTenantsPage />} />
            <Route path="/platform/tenants/new" element={<PlatformTenantsPage />} />
            <Route path="/platform/tenants/:id" element={<PlatformTenantsPage />} />
            <Route path="/platform/logs" element={<PlatformLogsPage />} />
            <Route path="/platform/settings" element={<PlatformSettingsPage />} />
          </Route>

          {/* ── ESPACE EMPLOYÉ (employee uniquement) ── */}
          <Route
            element={
              <RoleGuard allowedRoles={['employee']} redirectTo="/dashboard">
                <EmployeeLayout />
              </RoleGuard>
            }
          >
            <Route path="/mon-espace" element={<MonEspacePage />} />
            <Route path="/mon-espace/absences" element={<MesAbsencesPage />} />
            <Route path="/mon-espace/bulletins" element={<MesBulletinsPage />} />
            <Route path="/mon-espace/notes-de-frais" element={<MesNotesDeFraisPage />} />
            <Route path="/mon-espace/formation" element={<MaFormationPage />} />
            <Route path="/mon-espace/profil" element={<MonProfilPage />} />
            <Route path="/mon-espace/entretiens" element={<MonEntretienPage />} />
          </Route>

          {/* ── APPLICATION RH (admin, hr_manager, hr_officer, manager, readonly) ── */}
          <Route
            element={
              <RoleGuard
                allowedRoles={['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly', 'payroll_service']}
                redirectTo="/login"
              >
                <AppLayout />
              </RoleGuard>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />

            {/* Employees */}
            <Route path="/employees" element={<EmployeesPage />} />
            <Route path="/employees/new" element={<EmployeeNewPage />} />
            <Route path="/employees/orgchart" element={<OrgChartPage />} />
            <Route path="/employees/:id" element={<EmployeeDetailPage />} />

            {/* Payroll */}
            <Route path="/payroll" element={<PayrollPage />} />
            <Route path="/payroll/payslips" element={<PaySlipsPage />} />

            {/* Absences */}
            <Route path="/absences" element={<AbsencesPage />} />

            {/* Recruitment */}
            <Route path="/recruitment" element={<RecruitmentPage />} />

            {/* Training */}
            <Route path="/training" element={<TrainingPage />} />

            {/* Expenses */}
            <Route path="/expenses" element={<ExpensesPage />} />

            {/* Reporting */}
            <Route path="/reporting" element={<ReportingPage />} />

            {/* Self-service (kiosk) */}
            <Route path="/self-service" element={<SelfServicePage />} />

            {/* Careers */}
            <Route path="/careers" element={<CareersPage />} />

            {/* Settings */}
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          {/* Kiosk routes */}
          <Route element={<KioskLayout />}>
            <Route path="/kiosk" element={<SelfServicePage />} />
          </Route>

          {/* Catch all → login */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  )
}
