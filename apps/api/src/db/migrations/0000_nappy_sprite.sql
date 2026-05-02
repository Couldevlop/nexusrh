CREATE TABLE IF NOT EXISTS "absence_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"absence_type_id" uuid NOT NULL,
	"period_label" varchar(9) NOT NULL,
	"acquired" numeric(7, 2) DEFAULT '0',
	"taken" numeric(7, 2) DEFAULT '0',
	"pending" numeric(7, 2) DEFAULT '0',
	"carried" numeric(7, 2) DEFAULT '0',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "absence_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"label" varchar(100) NOT NULL,
	"category" varchar(30) NOT NULL,
	"counting_unit" varchar(20) DEFAULT 'working_days',
	"requires_justification" boolean DEFAULT false,
	"requires_approval" boolean DEFAULT true,
	"is_paid" boolean DEFAULT true,
	"impacts_payroll" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"color" varchar(7) DEFAULT '#4F46E5',
	"max_days_per_year" numeric(5, 2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "absences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"absence_type_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_half" varchar(10),
	"end_half" varchar(10),
	"days_count" numeric(5, 2) NOT NULL,
	"reason" text,
	"justification_url" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"payroll_impact" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" uuid,
	"old_value" text,
	"new_value" text,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"user_agent" text,
	"ip_address" varchar(45),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"role" varchar(30) DEFAULT 'employee' NOT NULL,
	"employee_id" uuid,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret" varchar(255),
	"google_id" varchar(255),
	"microsoft_id" varchar(255),
	"avatar_url" text,
	"last_login_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_reset_token" varchar(255),
	"password_reset_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"assessed_at" date,
	"assessed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"evaluator_id" uuid,
	"type" varchar(30) DEFAULT 'annual' NOT NULL,
	"year" smallint NOT NULL,
	"status" varchar(20) DEFAULT 'planned',
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"overall_rating" smallint,
	"goals_achievement" smallint,
	"skills_rating" jsonb DEFAULT '[]'::jsonb,
	"strengths" text,
	"improvements" text,
	"next_year_goals" jsonb DEFAULT '[]'::jsonb,
	"salary_increase_proposed" numeric(5, 2),
	"promotion_proposed" boolean DEFAULT false,
	"employee_comments" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nine_box" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"performance_axis" smallint NOT NULL,
	"potential_axis" smallint NOT NULL,
	"box" smallint NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"category" varchar(50),
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"code" varchar(20),
	"parent_id" uuid,
	"manager_id" uuid,
	"cost_center" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"file_url" text NOT NULL,
	"file_size" integer,
	"mime_type" varchar(100),
	"is_confidential" boolean DEFAULT false,
	"signed_by_employee" boolean DEFAULT false,
	"signed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"employee_number" varchar(50),
	"profile_type" varchar(30) DEFAULT 'employee' NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255),
	"phone" varchar(20),
	"birth_date" date,
	"birth_place" varchar(100),
	"nationality" varchar(2),
	"social_security_number" varchar(255),
	"iban" varchar(255),
	"bic" varchar(20),
	"address" jsonb,
	"hire_date" date,
	"end_date" date,
	"job_title" varchar(200),
	"job_level" varchar(50),
	"department_id" uuid,
	"manager_id" uuid,
	"working_time_percentage" numeric(5, 2) DEFAULT '100.00',
	"weekly_hours" numeric(5, 2) DEFAULT '35.00',
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"photo_url" text,
	"has_disability" boolean DEFAULT false,
	"retention_score" numeric(3, 2),
	"burnout_risk" varchar(10),
	"ai_score_updated_at" timestamp with time zone,
	"ai_score_factors" jsonb DEFAULT '[]'::jsonb,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "employees_employee_number_unique" UNIQUE("employee_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"event_date" date NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"is_private" boolean DEFAULT false,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"siren" varchar(9),
	"siret" varchar(14),
	"ape_code" varchar(5),
	"collective_agreement" varchar(100),
	"country_code" varchar(2) DEFAULT 'FR' NOT NULL,
	"address" jsonb,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"category" varchar(50) NOT NULL,
	"description" varchar(255) NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR',
	"receipt_url" text,
	"mileage" numeric(8, 2),
	"is_refundable" boolean DEFAULT true,
	"ocr_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"month" varchar(7) NOT NULL,
	"total_amount" numeric(10, 2) DEFAULT '0',
	"currency" varchar(3) DEFAULT 'EUR',
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"reimbursed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" varchar(30) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"trial_period_end" date,
	"gross_salary" numeric(12, 2) NOT NULL,
	"salary_basis" varchar(20) DEFAULT 'monthly',
	"working_hours_per_week" numeric(5, 2) DEFAULT '35',
	"collective_agreement" varchar(100),
	"job_classification" varchar(50),
	"non_competition_clause" boolean DEFAULT false,
	"telecommuting_days" smallint DEFAULT 0,
	"document_url" text,
	"status" varchar(20) DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pay_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone,
	"validated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"total_gross" numeric(14, 2),
	"total_net" numeric(14, 2),
	"total_employer_cost" numeric(14, 2),
	"payment_date" date
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pay_slips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"gross_salary" numeric(12, 2) NOT NULL,
	"net_before_tax" numeric(12, 2),
	"income_tax" numeric(12, 2) DEFAULT '0',
	"net_payable" numeric(12, 2) NOT NULL,
	"employer_cost" numeric(12, 2),
	"lines" jsonb NOT NULL,
	"variable_elements" jsonb DEFAULT '[]'::jsonb,
	"working_days" numeric(5, 2),
	"pdf_url" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"generated_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"viewed_by_employee_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"label" varchar(255) NOT NULL,
	"type" varchar(30) NOT NULL,
	"formula" text NOT NULL,
	"base" varchar(100),
	"employee_rate" numeric(8, 6),
	"employer_rate" numeric(8, 6),
	"ceiling_ss" numeric(3, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb,
	"valid_from" date,
	"valid_until" date,
	"legal_reference" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "variable_elements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"rule_code" varchar(50) NOT NULL,
	"label" varchar(255),
	"amount" numeric(12, 2),
	"quantity" numeric(8, 2),
	"rate" numeric(8, 6),
	"note" text,
	"source" varchar(30) DEFAULT 'manual',
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_offer_id" uuid NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(20),
	"current_position" varchar(200),
	"current_company" varchar(200),
	"cv_url" text,
	"cover_letter_url" text,
	"linkedin_url" text,
	"stage" varchar(30) DEFAULT 'new' NOT NULL,
	"score" integer,
	"notes" text,
	"ai_summary" text,
	"rejection_reason" text,
	"source" varchar(50),
	"expected_salary" numeric(10, 2),
	"available_from" date,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"interviewer_id" uuid,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration" integer DEFAULT 60,
	"type" varchar(30) DEFAULT 'video',
	"status" varchar(20) DEFAULT 'scheduled',
	"meeting_url" text,
	"feedback" text,
	"rating" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"department_id" uuid,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"requirements" text,
	"contract_type" varchar(30),
	"location" varchar(255),
	"remote" varchar(20) DEFAULT 'hybrid',
	"salary_min" numeric(10, 2),
	"salary_max" numeric(10, 2),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"hiring_manager_id" uuid,
	"required_by" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"provider" varchar(200),
	"format" varchar(30) DEFAULT 'in_person',
	"duration_hours" integer,
	"cpf_eligible" boolean DEFAULT false,
	"cpf_code" varchar(50),
	"cost" numeric(10, 2),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'enrolled',
	"completed_at" timestamp with time zone,
	"rating" integer,
	"feedback" text,
	"certificate" text,
	"cpf_hours_used" numeric(5, 2),
	"enrolled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"location" varchar(255),
	"max_participants" integer,
	"status" varchar(20) DEFAULT 'scheduled',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "absence_balances" ADD CONSTRAINT "absence_balances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "absence_balances" ADD CONSTRAINT "absence_balances_absence_type_id_absence_types_id_fk" FOREIGN KEY ("absence_type_id") REFERENCES "public"."absence_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "absence_types" ADD CONSTRAINT "absence_types_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "absences" ADD CONSTRAINT "absences_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "absences" ADD CONSTRAINT "absences_absence_type_id_absence_types_id_fk" FOREIGN KEY ("absence_type_id") REFERENCES "public"."absence_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "absences" ADD CONSTRAINT "absences_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_assessed_by_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_evaluator_id_employees_id_fk" FOREIGN KEY ("evaluator_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nine_box" ADD CONSTRAINT "nine_box_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nine_box" ADD CONSTRAINT "nine_box_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "departments" ADD CONSTRAINT "departments_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employees" ADD CONSTRAINT "employees_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_employees_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hr_events" ADD CONSTRAINT "hr_events_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_report_id_expense_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."expense_reports"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contracts" ADD CONSTRAINT "contracts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_periods" ADD CONSTRAINT "pay_periods_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_periods" ADD CONSTRAINT "pay_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_slips" ADD CONSTRAINT "pay_slips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_slips" ADD CONSTRAINT "pay_slips_period_id_pay_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pay_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_rules" ADD CONSTRAINT "payroll_rules_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variable_elements" ADD CONSTRAINT "variable_elements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variable_elements" ADD CONSTRAINT "variable_elements_period_id_pay_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pay_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variable_elements" ADD CONSTRAINT "variable_elements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidates" ADD CONSTRAINT "candidates_job_offer_id_job_offers_id_fk" FOREIGN KEY ("job_offer_id") REFERENCES "public"."job_offers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interviews" ADD CONSTRAINT "interviews_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interviews" ADD CONSTRAINT "interviews_interviewer_id_employees_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_hiring_manager_id_employees_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_courses" ADD CONSTRAINT "training_courses_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_session_id_training_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."training_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_course_id_training_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."training_courses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
