import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion } from "framer-motion";
import { Eye, EyeOff, Sparkles, Loader2 } from "lucide-react";
import { useLogin } from "@/hooks/useAuth";
import { useAuthStore } from "@/stores/authStore";
import { useNavigate } from "react-router-dom";

const loginSchema = z.object({
  email: z.string().email("Email invalide"),
  password: z.string().min(1, "Mot de passe requis"),
  mfaCode: z.string().optional(),
});

type LoginFormData = z.infer<typeof loginSchema>;

function getRedirectPath(role?: string): string {
  if (role === "super_admin") return "/platform/dashboard";
  if (role === "employee") return "/mon-espace";
  return "/dashboard";
}

export function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [requiresMfa, setRequiresMfa] = useState(false);
  const login = useLogin();
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(getRedirectPath(user.role), { replace: true });
    }
  }, [isAuthenticated, user, navigate]);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
    setError,
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormData) => {
    try {
      const result = await login.mutateAsync(data);
      if ((result as { requiresMfa?: boolean }).requiresMfa) {
        setRequiresMfa(true);
      }
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      setError("root", {
        message: error.response?.data?.message ?? "Erreur de connexion",
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-indigo-900 to-purple-900 flex items-center justify-center p-4">
      {/* Animated background */}
      <div className="absolute inset-0 overflow-hidden">
        {Array.from({ length: 20 }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-2 h-2 bg-white/10 rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
            }}
            animate={{
              y: [0, -30, 0],
              opacity: [0.1, 0.5, 0.1],
            }}
            transition={{
              duration: 3 + Math.random() * 4,
              repeat: Infinity,
              delay: Math.random() * 2,
            }}
          />
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative w-full max-w-md"
      >
        <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 border border-white/20 shadow-2xl">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-600 rounded-2xl mb-4 shadow-lg">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">NexusRH</h1>
            <p className="text-indigo-200 text-sm mt-1">
              SIRH nouvelle génération
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {errors.root && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-sm text-red-200"
              >
                {errors.root.message}
              </motion.div>
            )}

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-indigo-100 mb-1">
                Email
              </label>
              <input
                type="email"
                {...register("email")}
                placeholder="admin@nexusrh.com"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition-all"
              />
              {errors.email && (
                <p className="text-xs text-red-400 mt-1">
                  {errors.email.message}
                </p>
              )}
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-indigo-100 mb-1">
                Mot de passe
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  {...register("password")}
                  placeholder="••••••••"
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition-all pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white/80 transition-colors"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {errors.password && (
                <p className="text-xs text-red-400 mt-1">
                  {errors.password.message}
                </p>
              )}
            </div>

            {/* MFA */}
            {requiresMfa && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
              >
                <label className="block text-sm font-medium text-indigo-100 mb-1">
                  Code d'authentification (6 chiffres)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  {...register("mfaCode")}
                  placeholder="000000"
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-indigo-400 text-center text-2xl tracking-widest"
                />
              </motion.div>
            )}

            <button
              type="submit"
              disabled={login.isPending}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg"
            >
              {login.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              {login.isPending ? "Connexion..." : "Se connecter"}
            </button>

            <div className="text-center">
              <a
                href="#"
                className="text-sm text-indigo-300 hover:text-white transition-colors"
              >
                Mot de passe oublié ?
              </a>
            </div>
          </form>

          {/* Demo accounts */}
          <div className="mt-6 pt-6 border-t border-white/10">
            <p className="text-xs text-white/40 text-center mb-3">
              Comptes démo
            </p>
            {/* <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Super Admin', email: 'superadmin@nexusrh.com', tenant: 'Plateforme' },
                { label: 'Admin', email: 'admin@techcorp.com', tenant: 'TechCorp' },
                { label: 'RH Manager', email: 'rh@techcorp.com', tenant: 'TechCorp' },
                { label: 'Manager', email: 'manager@techcorp.com', tenant: 'TechCorp' },
                { label: 'Employé', email: 'employe@techcorp.com', tenant: 'TechCorp' },
                { label: 'Admin AP', email: 'admin@artisanpro.com', tenant: 'ArtisanPro' },
              ].map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setValue('email', acc.email, { shouldValidate: true })
                    setValue('password', acc.email === 'superadmin@nexusrh.com' ? 'SuperAdmin1234!' : 'Admin1234!', { shouldValidate: true })
                  }}
                  className="text-xs px-2 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/60 hover:text-white transition-all text-left"
                >
                  <span className="font-medium">{acc.label}</span>
                  <br />
                  <span className="opacity-50">{acc.tenant}</span>
                </button>
              ))}
            </div> */}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
