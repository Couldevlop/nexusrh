import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Suspense, lazy } from 'react'
import { ChunkLoadErrorBoundary } from '@/components/ChunkLoadErrorBoundary'
import { useAuthStore } from '@/stores/authStore'
import { AuthGuard, PlatformGuard, RoleGuard } from '@/guards/RoleGuard'
import { RedirectIfSubsidiaries } from '@/components/guards/RedirectIfSubsidiaries'

// ── Layouts ───────────────────────────────────────────────────────────────────
const MainLayout       = lazy(() => import('@/components/layout/MainLayout'))
const PlatformLayout   = lazy(() => import('@/components/layout/PlatformLayout'))
const EmployeeLayout   = lazy(() => import('@/components/layout/EmployeeLayout'))

// ── Auth ──────────────────────────────────────────────────────────────────────
const LoginPage          = lazy(() => import('@/pages/auth/LoginPage'))
const RafPeriodsPage     = lazy(() => import('@/pages/raf/RafPeriodsPage'))
const ForgotPasswordPage = lazy(() => import('@/pages/auth/ForgotPasswordPage'))
const ResetPasswordPage  = lazy(() => import('@/pages/auth/ResetPasswordPage'))
const PublicCareersPage  = lazy(() => import('@/pages/public/PublicCareersPage'))

// ── Platform (super_admin) ────────────────────────────────────────────────────
const PlatformDashboard   = lazy(() => import('@/pages/platform/PlatformDashboard'))
const PlatformTenants     = lazy(() => import('@/pages/platform/PlatformTenants'))
const PlatformTenantNew   = lazy(() => import('@/pages/platform/PlatformTenantNew'))
const PlatformTenantDetail  = lazy(() => import('@/pages/platform/PlatformTenantDetail'))
const PlatformSettings      = lazy(() => import('@/pages/platform/PlatformSettings'))
const PlatformLegalWatch    = lazy(() => import('@/pages/platform/PlatformLegalWatch'))

// ── RH Dashboard ─────────────────────────────────────────────────────────────
const DashboardPage    = lazy(() => import('@/pages/dashboard/DashboardPage'))

// ── Employees ─────────────────────────────────────────────────────────────────
const EmployeesPage    = lazy(() => import('@/pages/employees/EmployeesPage'))
const EmployeeDetail   = lazy(() => import('@/pages/employees/EmployeeDetail'))

// ── Payroll ───────────────────────────────────────────────────────────────────
const PayrollPage      = lazy(() => import('@/pages/payroll/PayrollPage'))
const PayrollMultiSitesPage = lazy(() => import('@/pages/payroll/PayrollMultiSitesPage'))
const PaySlipsPage     = lazy(() => import('@/pages/payroll/PaySlipsPage'))
const ItsSimulatorPage = lazy(() => import('@/pages/payroll/ItsSimulatorPage'))

// ── Absences ──────────────────────────────────────────────────────────────────
const AbsencesPage     = lazy(() => import('@/pages/absences/AbsencesPage'))

// ── Expenses (RH) ─────────────────────────────────────────────────────────────
const ExpensesPage     = lazy(() => import('@/pages/expenses/ExpensesPage'))

// ── Recruitment ───────────────────────────────────────────────────────────────
const RecruitmentPage  = lazy(() => import('@/pages/recruitment/RecruitmentPage'))

// ── Training ──────────────────────────────────────────────────────────────────
const TrainingPage     = lazy(() => import('@/pages/training/TrainingPage'))

// ── Careers ───────────────────────────────────────────────────────────────────
const CareersPage      = lazy(() => import('@/pages/careers/CareersPage'))

// ── Reporting ─────────────────────────────────────────────────────────────────
const ReportingPage    = lazy(() => import('@/pages/reporting/ReportingPage'))

// ── Settings ──────────────────────────────────────────────────────────────────
const SettingsPage     = lazy(() => import('@/pages/settings/SettingsPage'))

// ── CNPS ──────────────────────────────────────────────────────────────────────
const CnpsPage         = lazy(() => import('@/pages/cnps/CnpsPage'))
const CnpsAuditPage    = lazy(() => import('@/pages/cnps/CnpsAuditPage'))

// ── Contracts ─────────────────────────────────────────────────────────────────
const ContractsPage    = lazy(() => import('@/pages/contracts/ContractsPage'))

// ── Mobile Money ─────────────────────────────────────────────────────────────
const MobileMoneyPage  = lazy(() => import('@/pages/mobile-money/MobileMoneyPage'))

// ── Référentiel Droit CI ──────────────────────────────────────────────────────
const ReferentielsPage = lazy(() => import('@/pages/referentiels/ReferentielsPage'))

// ── Espace employé ────────────────────────────────────────────────────────────
const MonEspace        = lazy(() => import('@/pages/mon-espace/MonEspace'))
const MesAbsences      = lazy(() => import('@/pages/mon-espace/MesAbsences'))
const MesBulletins     = lazy(() => import('@/pages/mon-espace/MesBulletins'))
const MesNotesDesFrais = lazy(() => import('@/pages/mon-espace/MesNotesDesFrais'))
const MaFormation      = lazy(() => import('@/pages/mon-espace/MaFormation'))
const MaCarriere       = lazy(() => import('@/pages/mon-espace/MaCarriere'))
const MonProfil        = lazy(() => import('@/pages/mon-espace/MonProfil'))
const MesOffresInternes = lazy(() => import('@/pages/mon-espace/MesOffresInternes'))

// ── Loader ────────────────────────────────────────────────────────────────────
function PageLoader() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  )
}

// ── Redirect selon rôle ────────────────────────────────────────────────────────
function RootRedirect() {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'super_admin') return <Navigate to="/platform/dashboard" replace />
  if (user.role === 'employee') return <Navigate to="/mon-espace" replace />
  return <Navigate to="/dashboard" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <ChunkLoadErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Racine */}
          <Route path="/" element={<RootRedirect />} />

          {/* Auth */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          {/* ── Page carrières publique (sans auth) ───────────────── */}
          <Route path="/careers/:tenantSlug" element={<PublicCareersPage />} />

          {/* ── Portail super_admin ─────────────────────────────── */}
          <Route path="/platform" element={
            <PlatformGuard><PlatformLayout /></PlatformGuard>
          }>
            <Route index element={<Navigate to="/platform/dashboard" replace />} />
            <Route path="dashboard"    element={<PlatformDashboard />} />
            <Route path="tenants"      element={<PlatformTenants />} />
            <Route path="tenants/new"  element={<PlatformTenantNew />} />
            <Route path="tenants/:id"  element={<PlatformTenantDetail />} />
            <Route path="settings"     element={<PlatformSettings />} />
            <Route path="legal-watch"  element={<PlatformLegalWatch />} />
          </Route>

          {/* ── Application RH (admin, hr_manager, hr_officer, manager, readonly) ── */}
          <Route path="/" element={
            <AuthGuard><MainLayout /></AuthGuard>
          }>
            <Route path="dashboard" element={<DashboardPage />} />

            <Route path="employees" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','manager','readonly']}>
                <EmployeesPage />
              </RoleGuard>
            } />
            <Route path="employees/:id" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','manager','readonly']}>
                <EmployeeDetail />
              </RoleGuard>
            } />

            <Route path="payroll" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <RedirectIfSubsidiaries>
                  <PayrollPage />
                </RedirectIfSubsidiaries>
              </RoleGuard>
            } />
            <Route path="payroll/multi-filiales" element={
              <RoleGuard allowedRoles={['admin','hr_manager']}>
                <PayrollMultiSitesPage />
              </RoleGuard>
            } />
            <Route path="raf/periods" element={
              <RoleGuard allowedRoles={['raf_site','admin','hr_manager']}>
                <RafPeriodsPage />
              </RoleGuard>
            } />
            <Route path="payroll/payslips" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <PaySlipsPage />
              </RoleGuard>
            } />
            <Route path="payroll/simulateur-its" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer']}>
                <ItsSimulatorPage />
              </RoleGuard>
            } />

            <Route path="absences" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','manager','readonly']}>
                <AbsencesPage />
              </RoleGuard>
            } />

            <Route path="expenses-rh" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','manager']}>
                <ExpensesPage />
              </RoleGuard>
            } />

            <Route path="recruitment" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','manager','readonly']}>
                <RecruitmentPage />
              </RoleGuard>
            } />

            <Route path="training" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <TrainingPage />
              </RoleGuard>
            } />

            <Route path="careers" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','manager','readonly']}>
                <CareersPage />
              </RoleGuard>
            } />

            <Route path="reporting" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <ReportingPage />
              </RoleGuard>
            } />

            <Route path="settings" element={
              <RoleGuard allowedRoles={['admin']}>
                <SettingsPage />
              </RoleGuard>
            } />

            <Route path="contracts" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <ContractsPage />
              </RoleGuard>
            } />

            <Route path="cnps" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <CnpsPage />
              </RoleGuard>
            } />
            <Route path="cnps/audit" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer']}>
                <CnpsAuditPage />
              </RoleGuard>
            } />

            <Route path="mobile-money" element={
              <RoleGuard allowedRoles={['admin','hr_manager']}>
                <MobileMoneyPage />
              </RoleGuard>
            } />

            <Route path="referentiels" element={
              <RoleGuard allowedRoles={['admin','hr_manager','hr_officer','readonly']}>
                <ReferentielsPage />
              </RoleGuard>
            } />
          </Route>

          {/* ── Espace employé (self-service) ──────────────────────── */}
          <Route path="/mon-espace" element={
            <RoleGuard allowedRoles={['employee','admin','hr_manager','hr_officer','manager','readonly']}>
              <EmployeeLayout />
            </RoleGuard>
          }>
            <Route index               element={<MonEspace />} />
            <Route path="absences"     element={<MesAbsences />} />
            <Route path="bulletins"    element={<MesBulletins />} />
            <Route path="frais"        element={<MesNotesDesFrais />} />
            <Route path="formation"    element={<MaFormation />} />
            <Route path="carriere"     element={<MaCarriere />} />
            <Route path="offres"       element={<MesOffresInternes />} />
            <Route path="profil"       element={<MonProfil />} />
          </Route>

          {/* 404 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </ChunkLoadErrorBoundary>
    </BrowserRouter>
  )
}
