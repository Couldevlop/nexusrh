import openlabLogo from "@/assets/OPENLAB.png";
import nexusrhLogo from "@/assets/NexusRH.png";
import nexusrhLogoDark from "@/assets/NexusRH-dark.png";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation, Trans } from "react-i18next";
import { api } from "@/lib/api";
import {
  useAuthStore,
  applyTenantTheme,
  type AuthUser,
  type TenantConfig,
  type AgencyConfig,
} from "@/stores/authStore";
import { LanguageSwitcher } from "@/components/shared/LanguageSwitcher";
import { Loader2, Eye, EyeOff, ShieldCheck, CheckCircle } from "lucide-react";

// ── Schémas Zod ──────────────────────────────────────────────────────────────
// Les messages portent une clé i18n (namespace auth) résolue à l'affichage.

const loginSchema = z.object({
  email: z.string().email("auth:validation.emailInvalid"),
  password: z.string().min(1, "auth:validation.passwordRequired"),
});

const STRONG_PASSWORD = z
  .string()
  .min(12, "auth:validation.minChars")
  .regex(/[A-Z]/, "auth:validation.uppercase")
  .regex(/[a-z]/, "auth:validation.lowercase")
  .regex(/[0-9]/, "auth:validation.digit")
  .regex(/[^A-Za-z0-9]/, "auth:validation.special");

const changeSchema = z
  .object({
    newPassword: STRONG_PASSWORD,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "auth:validation.passwordsMismatch",
    path: ["confirmPassword"],
  });

type LoginForm = z.infer<typeof loginSchema>;
type ChangeForm = z.infer<typeof changeSchema>;

// ── Indicateur de force ───────────────────────────────────────────────────────

function PasswordStrength({ value }: { value: string }) {
  const { t } = useTranslation("auth");
  const checks = [
    { label: t("strength.chars"), ok: value.length >= 12 },
    { label: t("strength.uppercase"), ok: /[A-Z]/.test(value) },
    { label: t("strength.lowercase"), ok: /[a-z]/.test(value) },
    { label: t("strength.digit"), ok: /[0-9]/.test(value) },
    { label: t("strength.special"), ok: /[^A-Za-z0-9]/.test(value) },
  ];
  const score = checks.filter((c) => c.ok).length;
  const color =
    score <= 2
      ? "bg-red-500"
      : score <= 3
        ? "bg-amber-500"
        : score <= 4
          ? "bg-yellow-400"
          : "bg-emerald-500";

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-1">
        {checks.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${i < score ? color : "bg-muted"}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {checks.map((c) => (
          <div
            key={c.label}
            className={`flex items-center gap-1 text-xs ${c.ok ? "text-emerald-600" : "text-muted-foreground"}`}
          >
            <CheckCircle
              className={`h-3 w-3 shrink-0 ${c.ok ? "opacity-100" : "opacity-30"}`}
            />
            {c.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────

export default function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [error, setError] = useState<string | null>(null);
  // Mot de passe EXACT validé à la connexion — figé au moment de la soumission
  // du login. Réutilisé comme « ancien mot de passe » au changement forcé, au
  // lieu de relire le champ (qui peut être vide/altéré : autofill, re-render).
  const [loginPassword, setLoginPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);

  // Etat "première connexion" / changement forcé (expiration ou fuite)
  const [mustChange, setMustChange] = useState(false);
  // Raison d'un changement IMPOSÉ par la politique de sécurité (token restreint
  // pwdResetRequired). Si défini, on force une reconnexion après le changement
  // (on ne réutilise jamais le token restreint).
  const [forcedReason, setForcedReason] = useState<null | "expired" | "breached">(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  // Message hors-ligne mémorisé par l'intercepteur API : la session a été
  // coupée parce que le tenant/cabinet a été mis hors ligne par la plateforme.
  const [offlineNotice] = useState<string | null>(() => {
    try {
      const m = sessionStorage.getItem("nexusrh:offline-message");
      if (m !== null) sessionStorage.removeItem("nexusrh:offline-message");
      return m;
    } catch {
      return null;
    }
  });
  const [pendingAuth, setPendingAuth] = useState<{
    user: AuthUser;
    token: string;
    refreshToken: string;
    tenantConfig: TenantConfig | null;
    redirectTo: string;
  } | null>(null);

  // Etat "MFA requis" (2e étape login)
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaSubmitting, setMfaSubmitting] = useState(false);

  // PLT-020 — branding tenant résolu AVANT login (couleur + logo), depuis
  // ?tenant=slug dans l'URL (ou sous-domaine si présent). Endpoint public.
  const [brand, setBrand] = useState<{ name: string; logoUrl: string | null } | null>(null);
  useEffect(() => {
    let slug = "";
    try {
      slug = new URLSearchParams(window.location.search).get("tenant") ?? "";
      if (!slug) {
        const host = window.location.hostname;
        const sub = host.split(".")[0];
        if (host.includes(".") && sub && !["www", "api", "app", "localhost", "nexusrh", "127"].includes(sub)) {
          slug = sub;
        }
      }
    } catch { /* noop */ }
    if (!slug || !/^[a-z0-9-]{1,50}$/.test(slug)) return;
    api.get(`/public/brand/by-slug/${slug}`)
      .then((r) => {
        const b = r.data?.data;
        if (!b) return;
        applyTenantTheme({ primaryColor: b.primaryColor, secondaryColor: b.secondaryColor } as TenantConfig);
        setBrand({ name: b.name, logoUrl: b.logoUrl });
      })
      .catch(() => { /* slug inconnu → thème par défaut, pas d'erreur visible */ });
  }, []);

  // ── Formulaire login ──

  const loginForm = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  const onLogin = async (data: LoginForm) => {
    setError(null);
    // Fige le mot de passe soumis : c'est exactement celui que le serveur va
    // valider, donc le bon « ancien mot de passe » si un changement est imposé.
    setLoginPassword(data.password);
    try {
      const res = await api.post<{
        token?: string;
        refreshToken?: string;
        user?: AuthUser;
        tenantConfig?: TenantConfig | null;
        agencyConfig?: AgencyConfig | null;
        redirectTo?: string;
        must_change_password?: boolean;
        // Politique de sécurité (OWASP A07) :
        mfaSetupRequired?: boolean;
        passwordExpired?: boolean;
        passwordBreached?: boolean;
        // Réponse MFA 202 :
        mfaRequired?: boolean;
        challenge?: string;
      }>("/auth/login", data);

      // 202 Accepted : MFA déjà configuré → demander le code TOTP/backup
      if (res.status === 202 && res.data.mfaRequired && res.data.challenge) {
        setMfaChallenge(res.data.challenge);
        return;
      }

      // MFA OBLIGATOIRE mais pas encore configuré : token restreint au parcours
      // d'activation MFA. On connecte et on redirige vers la configuration MFA.
      if (res.data.mfaSetupRequired === true && res.data.user && res.data.token) {
        setAuth(
          res.data.user,
          res.data.token,
          res.data.refreshToken ?? "",
          res.data.tenantConfig ?? null,
        );
        navigate("/settings?tab=mfa", { replace: true });
        return;
      }

      if (res.data.must_change_password === true && res.data.user && res.data.token) {
        setPendingAuth(res.data as Required<typeof res.data>);
        // Changement IMPOSÉ par la politique (token restreint) vs première
        // connexion (token plein). On mémorise la raison pour adapter l'après-coup.
        setForcedReason(
          res.data.passwordBreached ? "breached"
            : res.data.passwordExpired ? "expired"
            : null,
        );
        setMustChange(true);
        return;
      }

      setAuth(
        res.data.user!,
        res.data.token!,
        res.data.refreshToken ?? "",
        res.data.tenantConfig ?? null,
        res.data.agencyConfig ?? null,
      );
      navigate(res.data.redirectTo ?? "/", { replace: true });
    } catch (err: unknown) {
      // OWASP A07 — message d'erreur générique pour éviter l'énumération
      // d'emails ("user introuvable" vs "mot de passe incorrect" trahit
      // l'existence d'un compte). On affiche le message API uniquement si
      // c'est une erreur 400 de validation (format), pas pour 401/4xx auth.
      const e = err as { response?: { status?: number; data?: { error?: string; offline?: boolean } } };
      const isValidation = e.response?.status === 400;
      // Tenant/cabinet mis hors ligne : le message configuré par la plateforme
      // est affiché tel quel (le serveur ne le renvoie qu'après vérification du
      // mot de passe — pas de risque d'énumération).
      const isOffline = e.response?.status === 503 && e.response?.data?.offline === true;
      setError(
        isOffline
          ? (e.response?.data?.error ?? t("errors.offlineFallback"))
          : isValidation
          ? (e.response?.data?.error ?? t("errors.invalidFormat"))
          : t("errors.invalidCredentials"),
      );
    }
  };

  // ── Vérification MFA (2e étape login si user a activé MFA) ──
  const onMfaVerify = async () => {
    if (!mfaChallenge || mfaCode.trim().length < 6) return;
    setMfaSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{
        token: string;
        user: AuthUser;
        tenantConfig: TenantConfig | null;
        redirectTo: string;
      }>("/auth/mfa/login-verify", {
        challenge: mfaChallenge,
        code: mfaCode.trim().toUpperCase(),
      });
      setAuth(res.data.user, res.data.token, "", res.data.tenantConfig);
      navigate(res.data.redirectTo ?? "/", { replace: true });
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      setError(e.response?.data?.error ?? t("mfa.invalidCode"));
    } finally {
      setMfaSubmitting(false);
    }
  };

  // ── Formulaire changement mot de passe ──

  const changeForm = useForm<ChangeForm>({
    resolver: zodResolver(changeSchema),
  });
  const pwdValue = changeForm.watch("newPassword") ?? "";

  const onChangePassword = async (data: ChangeForm) => {
    setError(null);
    try {
      await api.post(
        "/auth/change-password",
        {
          oldPassword: loginPassword,
          newPassword: data.newPassword,
        },
        {
          headers: { Authorization: `Bearer ${pendingAuth?.token}` },
        },
      );

      // Changement IMPOSÉ par la politique (expiration / fuite) : le token en
      // poche est RESTREINT (pwdResetRequired) et désormais caduc. On ne le
      // réutilise jamais — on force une reconnexion propre avec le nouveau mdp.
      if (forcedReason) {
        setMustChange(false);
        setPendingAuth(null);
        setForcedReason(null);
        loginForm.reset();
        setInfoMsg(
          forcedReason === "breached"
            ? t("change.successBreached")
            : t("change.successExpired"),
        );
        return;
      }

      // Première connexion (token plein) : on peut enchaîner directement.
      if (pendingAuth) {
        setAuth(
          pendingAuth.user,
          pendingAuth.token,
          pendingAuth.refreshToken,
          pendingAuth.tenantConfig,
        );
        navigate(pendingAuth.redirectTo ?? "/", { replace: true });
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(
        e.response?.data?.error ?? t("change.error"),
      );
    }
  };

  // ── Rendu ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen bg-background">
      {/* Panel gauche — branding (desktop uniquement) */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
        {/* Photo de fond */}
        <img
          src="https://images.unsplash.com/photo-1531482615713-2afd69097998?w=1200&q=80"
          alt={t("branding.imageAlt")}
          className="absolute inset-0 h-full w-full object-cover grayscale"
        />
        {/* Overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/85 via-primary/70 to-black/60" />
        {/* Contenu */}
        <div className="relative z-10 flex flex-col justify-between p-12 text-white w-full">
          <div className="flex items-center">
            <img src={nexusrhLogo} alt="NexusRH CI" className="h-14 w-auto object-contain drop-shadow" />
          </div>
          <div>
            <h2 className="text-4xl font-black leading-tight mb-4">
              {t("branding.heading")}
              <br />
              {t("branding.headingLine2")}
              <br />
              {t("branding.headingLine3")}
            </h2>
            <div className="space-y-3 mb-8">
              {[
                t("branding.feature1"),
                t("branding.feature2"),
                t("branding.feature3"),
                t("branding.feature4"),
              ].map((f) => (
                <div
                  key={f}
                  className="flex items-center gap-3 text-sm text-white/90"
                >
                  <div className="h-1.5 w-1.5 rounded-full bg-white shrink-0" />
                  {f}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <img
                src={openlabLogo}
                alt="OpenLab Consulting"
                className="h-7 w-auto object-contain brightness-0 invert opacity-70"
              />
              <span className="text-xs text-white/50">
                {t("branding.company")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Panel droit — formulaire */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-12 bg-gray-50 lg:bg-white">
        {/* Sélecteur de langue — coin supérieur droit */}
        <div className="absolute right-6 top-6">
          <LanguageSwitcher />
        </div>
        <div className="w-full max-w-md">

          {/* En-tête */}
          <div className="mb-8">
            <div className="lg:hidden flex items-center mb-6">
              {/* Variante sombre du logo (sans fond) — lisible sur surface claire */}
              <img src={nexusrhLogoDark} alt="NexusRH CI" className="h-9 w-auto object-contain" />
            </div>
            {/* PLT-020 — branding du tenant ciblé, affiché AVANT login */}
            {brand && (
              <div className="mb-6 flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                {brand.logoUrl ? (
                  <img src={brand.logoUrl} alt={brand.name} className="h-9 w-9 rounded-lg object-contain" />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white"
                    style={{ backgroundColor: "hsl(var(--primary))" }}>
                    {brand.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="text-xs text-gray-500">Espace de connexion</p>
                  <p className="text-sm font-bold text-gray-900">{brand.name}</p>
                </div>
              </div>
            )}
            {mfaChallenge ? (
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
                  <ShieldCheck className="h-5 w-5 text-indigo-600" />
                </div>
                <div>
                  <h1 className="text-lg font-bold text-gray-900">{t("mfa.title")}</h1>
                  <p className="text-xs text-gray-500">{t("mfa.subtitle")}</p>
                </div>
              </div>
            ) : !mustChange ? (
              <>
                <h1 className="text-2xl font-bold text-gray-900">{t("login.title")}</h1>
                <p className="mt-1 text-sm text-gray-500">{t("login.subtitle")}</p>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100">
                  <ShieldCheck className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <h1 className="text-lg font-bold text-gray-900">{t("change.title")}</h1>
                  <p className="text-xs text-gray-500">
                    {forcedReason === "breached"
                      ? t("change.reasonBreached")
                      : forcedReason === "expired"
                      ? t("change.reasonExpired")
                      : t("change.reasonFirst")}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Site mis hors ligne pendant la session : message configuré plateforme */}
          {offlineNotice !== null && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-semibold mb-0.5">{t("offline.title")}</p>
              <p>{offlineNotice || t("offline.fallback")}</p>
            </div>
          )}

          {/* Carte formulaire */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">

            {/* ── MFA (2e étape login) ── */}
            {mfaChallenge && (
              <form onSubmit={(e) => { e.preventDefault(); void onMfaVerify(); }} className="space-y-5">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {t("mfa.codeLabel")}
                  </label>
                  <input
                    autoFocus
                    type="text"
                    inputMode="text"
                    maxLength={10}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder={t("mfa.codePlaceholder")}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-center text-lg font-mono tracking-widest text-gray-900 placeholder-gray-400 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <p className="mt-1.5 text-xs text-gray-500">
                    {t("mfa.codeHint")}
                  </p>
                </div>
                {error && (
                  <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={mfaSubmitting || mfaCode.trim().length < 6}
                  className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {mfaSubmitting ? t("mfa.submitting") : t("mfa.submit")}
                </button>
                <button
                  type="button"
                  onClick={() => { setMfaChallenge(null); setMfaCode(""); setError(null); }}
                  className="w-full text-xs text-gray-500 hover:text-gray-700"
                >
                  {t("mfa.cancel")}
                </button>
              </form>
            )}

            {/* ── Connexion ── */}
            {!mfaChallenge && !mustChange && (
              <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-5">
                {infoMsg && (
                  <div className="rounded-xl bg-green-50 border border-green-100 px-4 py-3 text-sm text-green-700">
                    {infoMsg}
                  </div>
                )}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {t("login.emailLabel")}
                  </label>
                  <input
                    {...loginForm.register("email")}
                    type="email"
                    placeholder={t("login.emailPlaceholder")}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  {loginForm.formState.errors.email && (
                    <p className="mt-1.5 text-xs text-red-500">{t(loginForm.formState.errors.email.message ?? "")}</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {t("login.passwordLabel")}
                  </label>
                  <div className="relative">
                    <input
                      {...loginForm.register("password")}
                      type={showPwd ? "text" : "password"}
                      placeholder={t("login.passwordPlaceholder")}
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 pr-11 text-sm text-gray-900 placeholder-gray-400 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <button type="button" onClick={() => setShowPwd(v => !v)}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {loginForm.formState.errors.password && (
                    <p className="mt-1.5 text-xs text-red-500">{t(loginForm.formState.errors.password.message ?? "")}</p>
                  )}
                </div>

                {error && (
                  <div className="flex items-start gap-2.5 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                    <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                    <p className="text-xs text-red-700">{error}</p>
                  </div>
                )}

                <button type="submit" disabled={loginForm.formState.isSubmitting}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:opacity-60">
                  {loginForm.formState.isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loginForm.formState.isSubmitting ? t("login.submitting") : t("login.submit")}
                </button>

                <div className="text-center">
                  <a href="/forgot-password" className="text-xs text-gray-500 hover:text-primary hover:underline">
                    {t("login.forgotPassword")}
                  </a>
                </div>
              </form>
            )}

            {/* ── Première connexion ── */}
            {!mfaChallenge && mustChange && (
              <form onSubmit={changeForm.handleSubmit(onChangePassword)} className="space-y-5">
                <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-xs text-amber-800">
                  <Trans i18nKey="change.policyHint" ns="auth" components={{ strong: <strong /> }} />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {t("change.newPasswordLabel")}
                  </label>
                  <div className="relative">
                    <input
                      {...changeForm.register("newPassword")}
                      type={showNewPwd ? "text" : "password"}
                      placeholder={t("change.newPasswordPlaceholder")}
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 pr-11 text-sm text-gray-900 placeholder-gray-400 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <button type="button" onClick={() => setShowNewPwd(v => !v)}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {pwdValue && <PasswordStrength value={pwdValue} />}
                  {changeForm.formState.errors.newPassword && (
                    <p className="mt-1.5 text-xs text-red-500">{t(changeForm.formState.errors.newPassword.message ?? "")}</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {t("change.confirmLabel")}
                  </label>
                  <input
                    {...changeForm.register("confirmPassword")}
                    type="password"
                    placeholder={t("change.confirmPlaceholder")}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 transition focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  {changeForm.formState.errors.confirmPassword && (
                    <p className="mt-1.5 text-xs text-red-500">{t(changeForm.formState.errors.confirmPassword.message ?? "")}</p>
                  )}
                </div>

                {error && (
                  <div className="flex items-start gap-2.5 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                    <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                    <p className="text-xs text-red-700">{error}</p>
                  </div>
                )}

                <button type="submit" disabled={changeForm.formState.isSubmitting}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:opacity-60">
                  {changeForm.formState.isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {changeForm.formState.isSubmitting ? t("change.submitting") : t("change.submit")}
                </button>
              </form>
            )}
          </div>

          {/* Footer */}
          <div className="mt-6 flex items-center justify-center gap-2 opacity-50 hover:opacity-80 transition-opacity">
            <img src={openlabLogo} alt="OpenLab" className="h-5 w-auto object-contain" />
            <span className="text-xs text-gray-400">{t("footer.company")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
